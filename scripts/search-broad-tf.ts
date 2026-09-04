import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { BacktestConfig, Timeframe } from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import { CHAMPS, type ChampId } from "@/lib/fund/champs";
import { runRotate, type RotateOpts } from "@/lib/fund/rotate";

/**
 * sf-broad 上搜 2H / 1H / 1d。选参与 4H 相同：三段最差 MAR，且尽量三段都不亏。
 * 不写 champs。日线入每根=入收盘，网格只留收盘。
 *
 *   NODE_OPTIONS=--max-old-space-size=8192 npx --yes tsx scripts/search-broad-tf.ts 2h
 *   NODE_OPTIONS=--max-old-space-size=6144 npx --yes tsx scripts/search-broad-tf.ts 1d
 *
 * 网格可用 --workers 4 分片。子进程会带 --shard i/n。
 */

const COST = 10;
const W = { from: "2021-08-24", to: "2026-08-24" };
const TR = { from: "2021-08-24", to: "2024-08-24" };
const OOS = { from: "2024-08-25", to: "2026-08-24" };
const SEG3 = [
  { from: "2021-08-24", to: "2023-04-24" },
  { from: "2023-04-24", to: "2024-12-24" },
  { from: "2024-12-24", to: "2026-08-24" },
];

const tf = (process.argv[2] ?? "").toLowerCase();
if (tf !== "2h" && tf !== "1h" && tf !== "1d") {
  console.error("usage: tsx scripts/search-broad-tf.ts 2h|1h|1d [--workers 4] [--shard i/n]");
  process.exit(1);
}

const TF = tf as Timeframe;
const CHAMP_ID = tf as ChampId;
const OUT = `/tmp/search-broad-${tf}.json`;
const TAG = `broad-${tf}`;
const ENTRY_WINDOWS = (tf === "1d" ? (["dayClose"] as const) : (["all", "dayClose"] as const));
const EXIT_WINDOWS = (tf === "1d" ? (["all"] as const) : (["all", "dayClose"] as const));
const TOTAL = 4 * 4 * 2 * 3 * 4 * ENTRY_WINDOWS.length;

type Opts = RotateOpts;
type Mode = RotateOpts["mode"];
type Grid = { over: Record<string, unknown>; o: Opts; label: string; m3: number; bearCagr: number; robust: boolean };

const worst = (rs: { cagr: number; dd: number }[]) => {
  const cagr = Math.min(...rs.map((r) => r.cagr));
  const dd = Math.max(...rs.map((r) => r.dd));
  return { cagr, dd, mar: dd > 0 ? cagr / dd : 0 };
};

function argVal(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function cfg(base: BacktestConfig, over: Record<string, unknown>, win: { from: string; to: string }): BacktestConfig {
  return { ...base, ...over, ...win, timeframe: TF };
}

function lean(o: Opts): Opts {
  return { ...o, statsOnly: true };
}

type Score = {
  label: string;
  over: Record<string, unknown>;
  o: Opts;
  cagr: number;
  dd: number;
  mar: number;
  m3: number;
  segs: { cagr: number; dd: number; mar: number }[];
  bearCagr: number;
  tr: number;
  oos: number;
  entries: number;
  robust: boolean;
};

function scoreSegs(
  uni: Awaited<ReturnType<typeof getPreparedUniverse>>,
  base: BacktestConfig,
  over: Record<string, unknown>,
  o: Opts,
  label: string,
): Score {
  const opts = lean(o);
  const segs = SEG3.map((w) => runRotate(uni, cfg(base, over, w), opts));
  const w3 = worst(segs);
  return {
    label,
    over,
    o,
    cagr: 0,
    dd: 0,
    mar: 0,
    m3: w3.mar,
    segs: segs.map((s) => ({ cagr: s.cagr, dd: s.dd, mar: s.mar })),
    bearCagr: segs[0].cagr,
    tr: 0,
    oos: 0,
    entries: 0,
    robust: segs.every((s) => s.cagr >= 0),
  };
}

function scoreFull(
  uni: Awaited<ReturnType<typeof getPreparedUniverse>>,
  base: BacktestConfig,
  over: Record<string, unknown>,
  o: Opts,
  label: string,
): Score {
  const opts = lean(o);
  const f = runRotate(uni, cfg(base, over, W), opts);
  const segs = SEG3.map((w) => runRotate(uni, cfg(base, over, w), opts));
  const w3 = worst(segs);
  const tr = runRotate(uni, cfg(base, over, TR), opts);
  const os = runRotate(uni, cfg(base, over, OOS), opts);
  return {
    label,
    over,
    o,
    cagr: f.cagr,
    dd: f.dd,
    mar: f.mar,
    m3: w3.mar,
    segs: segs.map((s) => ({ cagr: s.cagr, dd: s.dd, mar: s.mar })),
    bearCagr: segs[0].cagr,
    tr: tr.mar,
    oos: os.mar,
    entries: f.entries,
    robust: segs.every((s) => s.cagr >= 0),
  };
}

function slim(s: Score) {
  return {
    label: s.label,
    cagr: +s.cagr.toFixed(2),
    dd: +s.dd.toFixed(2),
    mar: +s.mar.toFixed(2),
    m3: +s.m3.toFixed(2),
    bearCagr: +s.bearCagr.toFixed(1),
    segs: s.segs.map((x) => ({ cagr: +x.cagr.toFixed(1), dd: +x.dd.toFixed(1), mar: +x.mar.toFixed(2) })),
    tr: +s.tr.toFixed(2),
    oos: +s.oos.toFixed(2),
    entries: s.entries,
    robust: s.robust,
    over: s.over,
    o: { slotPct: s.o.slotPct, mode: s.o.mode, edge: s.o.edge, entryWindow: s.o.entryWindow, exitWindow: s.o.exitWindow },
  };
}

function baselineLabel(champ: (typeof CHAMPS)[number]): string {
  const c = champ.config;
  const o = champ.opts;
  const tp = c.takeProfitR ? `盈${c.takeProfitR}R` : "无盈";
  const rsi = c.requireRsi ? `RSI≥${c.minRsi}` : "RSI关";
  const rot = o.mode === "none" ? "不置换" : `置换+${o.edge}`;
  return `现定档 止${c.stopMult}吊${c.trailMult}${tp}门${c.rpsMin} ${(o.slotPct * 100).toFixed(1)}% ${rsi} ${rot}`;
}

function* cells() {
  let i = 0;
  for (const stopMult of [4, 5, 6, 8])
    for (const trailMult of [5, 6, 8, 10])
      for (const takeProfitR of [null, 3] as const)
        for (const rpsMin of [0, 10, 30])
          for (const slotPct of [0.05, 0.08, 0.1, 0.125])
            for (const ew of ENTRY_WINDOWS) {
              yield { i: i++, stopMult, trailMult, takeProfitR, rpsMin, slotPct, ew };
            }
}

function scoreCell(
  uni: Awaited<ReturnType<typeof getPreparedUniverse>>,
  base: BacktestConfig,
  cell: ReturnType<typeof cells> extends Generator<infer C> ? C : never,
): Grid {
  const { stopMult, trailMult, takeProfitR, rpsMin, slotPct, ew } = cell;
  const over = { stopMult, trailMult, takeProfitR, rpsMin };
  const o: Opts = { slotPct, mode: "none", edge: 0, costBps: COST, entryWindow: ew, exitWindow: "all" };
  const segs: { cagr: number; dd: number }[] = [];
  for (const w of SEG3) {
    const r = runRotate(uni, cfg(base, over, w), lean(o));
    segs.push(r);
    if (r.cagr < 0) break;
  }
  const w3 = worst(segs);
  return {
    over,
    o,
    label: `止${stopMult} 吊${trailMult} ${takeProfitR ? `盈${takeProfitR}R` : "无盈"} 门${rpsMin} ${(slotPct * 100).toFixed(1)}% 入${ew === "all" ? "每根" : "收盘"}`,
    m3: w3.mar,
    bearCagr: segs[0].cagr,
    robust: segs.length === SEG3.length && segs.every((s) => s.cagr >= 0),
  };
}

function shardPath(i: number, n: number) {
  return `/tmp/search-broad-${tf}.shard${i}of${n}.json`;
}

function tsxNodeArgs(): string[] {
  const requireAt = process.execArgv.indexOf("--require");
  const importAt = process.execArgv.indexOf("--import");
  if (requireAt < 0 || importAt < 0) {
    throw new Error("parent is not running under tsx; cannot spawn shards");
  }
  return ["--require", process.execArgv[requireAt + 1], "--import", process.execArgv[importAt + 1]];
}

function runWorkers(workers: number): Promise<Grid[]> {
  return new Promise((resolve, reject) => {
    const results: Grid[][] = Array.from({ length: workers }, () => []);
    let left = workers;
    let failed = false;
    const loader = tsxNodeArgs();
    for (let i = 0; i < workers; i += 1) {
      const child = spawn(
        process.execPath,
        [...loader, "scripts/search-broad-tf.ts", tf, "--shard", `${i}/${workers}`],
        { stdio: ["ignore", "inherit", "inherit"], env: process.env, cwd: process.cwd(), detached: true },
      );
      child.on("exit", (code) => {
        if (failed) return;
        if (code !== 0) {
          failed = true;
          reject(new Error(`shard ${i}/${workers} exit ${code}`));
          return;
        }
        const p = shardPath(i, workers);
        if (!existsSync(p)) {
          failed = true;
          reject(new Error(`missing ${p}`));
          return;
        }
        results[i] = JSON.parse(readFileSync(p, "utf8")) as Grid[];
        left -= 1;
        if (left === 0) resolve(results.flat());
      });
    }
  });
}

async function loadUni() {
  const champ = CHAMPS.find((c) => c.id === CHAMP_ID)!;
  const uni = await getPreparedUniverse("SMALLFUND", TF, "sf-broad");
  console.error(`[${TAG}] symbols ${uni.symbols.length} axis ${uni.axis.length}`);
  return { champ, base: champ.config, uni };
}

async function runShard(shard: number, shards: number) {
  const { base, uni } = await loadUni();
  const grid: Grid[] = [];
  let n = 0;
  const out = shardPath(shard, shards);
  for (const cell of cells()) {
    if (cell.i % shards !== shard) continue;
    grid.push(scoreCell(uni, base, cell));
    n += 1;
    if (n % 8 === 0) {
      process.stderr.write(`[${TAG}] shard ${shard}/${shards} ${n}\n`);
      writeFileSync(out, JSON.stringify(grid));
    }
  }
  writeFileSync(out, JSON.stringify(grid));
  console.error(`[${TAG}] shard ${shard}/${shards} done ${grid.length}`);
}

async function finish(grid: Grid[]) {
  const { champ, base, uni } = await loadUni();
  const baseline = scoreFull(
    uni,
    base,
    {
      stopMult: champ.config.stopMult,
      trailMult: champ.config.trailMult,
      takeProfitR: champ.config.takeProfitR,
      rpsMin: champ.config.rpsMin,
      requireRsi: champ.config.requireRsi,
      minRsi: champ.config.minRsi,
      rpsExit: champ.config.rpsExit,
    },
    { ...champ.opts, costBps: COST },
    baselineLabel(champ),
  );
  console.error(`[${TAG}] baseline m3=${baseline.m3.toFixed(2)} mar=${baseline.mar.toFixed(2)} bear=${baseline.bearCagr.toFixed(1)}`);

  const robust = grid.filter((g) => g.robust).sort((a, b) => b.m3 - a.m3);
  const byM3 = [...grid].sort((a, b) => b.m3 - a.m3);
  console.error(`[${TAG}] robust ${robust.length}/${grid.length}  top m3=${(robust[0] ?? byM3[0]).m3.toFixed(2)}`);

  const seeds = (robust.length > 0 ? robust : byM3).slice(0, 8);
  const seedGrid = seeds[0];
  console.error(`[${TAG}] seed ${seedGrid.label} m3=${seedGrid.m3.toFixed(2)}`);

  const RSI = [
    { label: "RSI关", over: { requireRsi: false } },
    { label: "RSI≥30", over: { requireRsi: true, minRsi: 30 } },
    { label: "RSI≥50", over: { requireRsi: true, minRsi: 50 } },
  ];
  const EXITS: (number | null)[] = [null, 10];
  const ROTS: { label: string; mode: Mode; edge: number }[] = [
    { label: "不置换", mode: "none", edge: 0 },
    { label: "置换+0", mode: "weakest", edge: 0 },
  ];
  const XW = EXIT_WINDOWS;

  const stage2: Score[] = [];
  let k = 0;
  const STAGE2 = RSI.length * EXITS.length * ROTS.length * XW.length;
  for (const gate of RSI)
    for (const rpsExit of EXITS)
      for (const rot of ROTS)
        for (const xw of XW) {
          const over = { ...seedGrid.over, ...gate.over, rpsExit };
          const o: Opts = {
            slotPct: seedGrid.o.slotPct,
            mode: rot.mode,
            edge: rot.edge,
            costBps: COST,
            entryWindow: seedGrid.o.entryWindow,
            exitWindow: xw,
          };
          stage2.push(
            scoreSegs(uni, base, over, o, `${seedGrid.label} ${gate.label} 出场${rpsExit ?? "关"} ${rot.label} 平${xw === "all" ? "每根" : "收盘"}`),
          );
          k += 1;
          if (k % 8 === 0) process.stderr.write(`[${TAG}] stage2 ${k}/${STAGE2}\n`);
        }

  stage2.sort((a, b) => (b.robust === a.robust ? b.m3 - a.m3 : Number(b.robust) - Number(a.robust)));
  const finalists = stage2.filter((s) => s.robust).slice(0, 4);
  const top = (finalists.length > 0 ? finalists : stage2.slice(0, 4)).map((s) => scoreFull(uni, base, s.over, s.o, s.label));
  top.sort((a, b) => (b.robust === a.robust ? b.m3 - a.m3 : Number(b.robust) - Number(a.robust)));
  const pick = top.find((s) => s.robust) ?? top[0];
  const topGrid = seeds.slice(0, 4).map((g) => scoreFull(uni, base, g.over, g.o, g.label));
  topGrid.sort((a, b) => b.m3 - a.m3);
  const seed = topGrid.find((s) => s.robust) ?? topGrid[0];

  const neighbors = grid
    .filter((g) => {
      const o = g.over;
      return (
        Math.abs(Number(o.stopMult) - Number(seed.over.stopMult)) <= 2 &&
        Math.abs(Number(o.trailMult) - Number(seed.over.trailMult)) <= 2 &&
        o.takeProfitR === seed.over.takeProfitR &&
        o.rpsMin === seed.over.rpsMin &&
        g.o.slotPct === seed.o.slotPct &&
        g.o.entryWindow === seed.o.entryWindow
      );
    })
    .sort((a, b) => b.m3 - a.m3)
    .slice(0, 10)
    .map((g) => ({ label: g.label, m3: +g.m3.toFixed(2), bearCagr: +g.bearCagr.toFixed(1), robust: g.robust }));

  const out = {
    timeframe: TF,
    symbols: uni.symbols.length,
    rule: "先三段都不亏，再比三段最差 MAR；全期 MAR / 后两年 OOS 只作对照",
    baseline: slim(baseline),
    robustCount: robust.length,
    gridTop: topGrid.map(slim),
    stage2Top: top.map(slim),
    pick: slim(pick),
    neighbors,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

function loadShards(n: number): Grid[] {
  return Array.from({ length: n }, (_, i) => {
    const p = shardPath(i, n);
    if (!existsSync(p)) throw new Error(`missing ${p}`);
    return JSON.parse(readFileSync(p, "utf8")) as Grid[];
  }).flat();
}

async function main() {
  const shardArg = argVal("--shard");
  const workers = Number(argVal("--workers") ?? "1");
  if (process.argv.includes("--finish-only")) {
    await finish(loadShards(Number(argVal("--shards") ?? "4")));
    return;
  }
  if (shardArg) {
    const [a, b] = shardArg.split("/").map(Number);
    await runShard(a, b);
    return;
  }
  if (workers > 1) {
    console.error(`[${TAG}] grid ${TOTAL} via ${workers} workers`);
    const grid = await runWorkers(workers);
    await finish(grid);
    return;
  }
  const { base, uni } = await loadUni();
  const grid: Grid[] = [];
  let n = 0;
  for (const cell of cells()) {
    grid.push(scoreCell(uni, base, cell));
    n += 1;
    if (n % 32 === 0) {
      process.stderr.write(`[${TAG}] grid ${n}/${TOTAL}\n`);
      writeFileSync(OUT, JSON.stringify({ phase: "grid", n, total: TOTAL }, null, 2));
    }
  }
  await finish(grid);
}

main();
