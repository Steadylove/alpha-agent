import { writeFileSync } from "node:fs";

import type { BacktestConfig } from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import { CHAMPS } from "@/lib/fund/champs";
import { runRotate, type RotateOpts } from "@/lib/fund/rotate";

/**
 * sf-broad 上搜 4H。选参：三段最差 MAR，且尽量三段都不亏。
 * 不写 champs。格子加了 5%——扩池后 8% 会堵死，这是结构问题不是加轴钓鱼。
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
const OUT = "/tmp/search-broad-4h.json";

type Opts = RotateOpts;
type Mode = RotateOpts["mode"];

const worst = (rs: { cagr: number; dd: number }[]) => {
  const cagr = Math.min(...rs.map((r) => r.cagr));
  const dd = Math.max(...rs.map((r) => r.dd));
  return { cagr, dd, mar: dd > 0 ? cagr / dd : 0 };
};

function cfg(base: BacktestConfig, over: Record<string, unknown>, win: { from: string; to: string }): BacktestConfig {
  return { ...base, ...over, ...win, timeframe: "4h" };
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

function scoreFull(uni: Awaited<ReturnType<typeof getPreparedUniverse>>, base: BacktestConfig, over: Record<string, unknown>, o: Opts, label: string): Score {
  const f = runRotate(uni, cfg(base, over, W), o);
  const segs = SEG3.map((w) => runRotate(uni, cfg(base, over, w), o));
  const w3 = worst(segs);
  const tr = runRotate(uni, cfg(base, over, TR), o);
  const os = runRotate(uni, cfg(base, over, OOS), o);
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

async function main() {
  const champ = CHAMPS.find((c) => c.id === "4h")!;
  const base = champ.config;
  const uni = await getPreparedUniverse("SMALLFUND", "4h", "sf-broad");
  console.error(`[broad-4h] symbols ${uni.symbols.length}`);

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
    "现定档 止8吊10无盈门0 8% RSI≥30 不置换",
  );
  console.error(`[broad-4h] baseline m3=${baseline.m3.toFixed(2)} mar=${baseline.mar.toFixed(2)} bear=${baseline.bearCagr.toFixed(1)}`);

  type Grid = { over: Record<string, unknown>; o: Opts; label: string; m3: number; bearCagr: number; robust: boolean };
  const grid: Grid[] = [];
  let n = 0;
  const TOTAL = 4 * 4 * 2 * 3 * 4 * 2;
  for (const stopMult of [4, 5, 6, 8])
    for (const trailMult of [5, 6, 8, 10])
      for (const takeProfitR of [null, 3])
        for (const rpsMin of [0, 10, 30])
          for (const slotPct of [0.05, 0.08, 0.1, 0.125])
            for (const ew of ["all", "dayClose"] as const) {
              const over = { stopMult, trailMult, takeProfitR, rpsMin };
              const o: Opts = { slotPct, mode: "none", edge: 0, costBps: COST, entryWindow: ew, exitWindow: "all" };
              const segs = SEG3.map((w) => runRotate(uni, cfg(base, over, w), o));
              const w3 = worst(segs);
              grid.push({
                over,
                o,
                label: `止${stopMult} 吊${trailMult} ${takeProfitR ? `盈${takeProfitR}R` : "无盈"} 门${rpsMin} ${(slotPct * 100).toFixed(1)}% 入${ew === "all" ? "每根" : "收盘"}`,
                m3: w3.mar,
                bearCagr: segs[0].cagr,
                robust: segs.every((s) => s.cagr >= 0),
              });
              n += 1;
              if (n % 64 === 0) {
                process.stderr.write(`[broad-4h] grid ${n}/${TOTAL}\n`);
                writeFileSync(OUT, JSON.stringify({ phase: "grid", n, total: TOTAL }, null, 2));
              }
            }

  const robust = grid.filter((g) => g.robust).sort((a, b) => b.m3 - a.m3);
  const byM3 = [...grid].sort((a, b) => b.m3 - a.m3);
  console.error(`[broad-4h] robust ${robust.length}/${grid.length}  top m3=${(robust[0] ?? byM3[0]).m3.toFixed(2)}`);

  const seeds = (robust.length > 0 ? robust : byM3).slice(0, 8);
  const topGrid = seeds.map((g) => scoreFull(uni, base, g.over, g.o, g.label));
  topGrid.sort((a, b) => b.m3 - a.m3);
  const seed = topGrid.find((s) => s.robust) ?? topGrid[0];
  console.error(`[broad-4h] seed ${seed.label} m3=${seed.m3.toFixed(2)}`);

  const RSI = [
    { label: "RSI关", over: { requireRsi: false } },
    { label: "RSI≥20", over: { requireRsi: true, minRsi: 20 } },
    { label: "RSI≥30", over: { requireRsi: true, minRsi: 30 } },
    { label: "RSI≥50", over: { requireRsi: true, minRsi: 50 } },
  ];
  const EXITS: (number | null)[] = [null, 10, 30];
  const ROTS: { label: string; mode: Mode; edge: number }[] = [
    { label: "不置换", mode: "none", edge: 0 },
    { label: "置换+0", mode: "weakest", edge: 0 },
    { label: "置换+20", mode: "weakest", edge: 20 },
  ];
  const XW = ["all", "dayClose"] as const;

  const stage2: Score[] = [];
  let k = 0;
  for (const gate of RSI)
    for (const rpsExit of EXITS)
      for (const rot of ROTS)
        for (const xw of XW) {
          const over = { ...seed.over, ...gate.over, rpsExit };
          const o: Opts = {
            slotPct: seed.o.slotPct,
            mode: rot.mode,
            edge: rot.edge,
            costBps: COST,
            entryWindow: seed.o.entryWindow,
            exitWindow: xw,
          };
          stage2.push(
            scoreFull(uni, base, over, o, `${seed.label} ${gate.label} 出场${rpsExit ?? "关"} ${rot.label} 平${xw === "all" ? "每根" : "收盘"}`),
          );
          k += 1;
          if (k % 12 === 0) process.stderr.write(`[broad-4h] stage2 ${k}/72\n`);
        }

  stage2.sort((a, b) => (b.robust === a.robust ? b.m3 - a.m3 : Number(b.robust) - Number(a.robust)));
  const pick = stage2.find((s) => s.robust) ?? stage2[0];

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
    symbols: uni.symbols.length,
    rule: "先三段都不亏，再比三段最差 MAR；全期 MAR / 后两年 OOS 只作对照",
    baseline: slim(baseline),
    robustCount: robust.length,
    gridTop: topGrid.map(slim),
    stage2Top: stage2.slice(0, 8).map(slim),
    pick: slim(pick),
    neighbors,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main();
