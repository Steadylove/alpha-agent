import "dotenv/config";

import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  type BacktestConfig,
  type PreparedUniverse,
} from "@/lib/backtest/engine";
import { loadPreparedUniverse } from "@/lib/backtest/load";
import {
  SMALL_FUND_2H_DEFAULT_CONFIG,
  SMALL_FUND_2H_FROM,
  SMALL_FUND_TO,
} from "@/lib/backtest/smallFundUniverse";

/**
 * Small Fund 2H 网格。整段五年既训练又评分，数字偏乐观。
 *
 *   npx tsx scripts/search-smallfund-2h.ts
 */

const MIN_TRADES = 120;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

type Row = {
  config: BacktestConfig;
  excess: number;
  cagr: number;
  bench: number;
  trades: number;
  win: number;
  dd: number;
  invested: number;
  years: { year: number; strat: number; bench: number; trades: number }[];
};

function base(override: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    ...SMALL_FUND_2H_DEFAULT_CONFIG,
    from: SMALL_FUND_2H_FROM,
    to: SMALL_FUND_TO,
    timeframe: "2h",
    requireRsi: false,
    requireVegas: false,
    rpsWeightPower: 1,
    useBuy1: true,
    useBuy2: true,
    ...override,
  };
}

function evalCfg(universe: PreparedUniverse, override: Partial<BacktestConfig> = {}): Row {
  const config = base(override);
  const r = runBacktest(universe, config);
  const w = r.inSample;
  return {
    config,
    excess: w.portfolio.cagrPct - w.benchmark.cagrPct,
    cagr: w.portfolio.cagrPct,
    bench: w.benchmark.cagrPct,
    trades: w.trade.trades,
    win: w.trade.winRatePct,
    dd: w.portfolio.maxDrawdownPct,
    invested: w.portfolio.investedDayPct,
    years: r.byYear.map((y) => ({
      year: y.year,
      strat: y.strategyPct,
      bench: y.benchmarkPct,
      trades: y.trades,
    })),
  };
}

const label = (c: BacktestConfig) =>
  `${c.requireVegas ? "Vg开" : "Vg关"} ${c.requireRsi ? "RSI" : "R关"} ` +
  `RPS${String(c.rpsMin).padStart(2)} 止损${c.stopMult} 吊灯${String(c.trailMult).padEnd(3)} ` +
  `止盈${(c.takeProfitR == null ? "无" : `${c.takeProfitR}R`).padEnd(3)} ` +
  `${c.useBuy2 ? "一+二" : "一买"} k=${c.rpsWeightPower ?? "等"}`;

function print(title: string, rows: Row[], n = 15) {
  console.log(`\n${title}`);
  console.log(
    `${"参数".padEnd(52)} ${"超额".padStart(8)} ${"年化".padStart(8)} ${"基准".padStart(8)} ` +
      `${"笔".padStart(5)} ${"胜率".padStart(6)} ${"回撤".padStart(7)} ${"持仓".padStart(5)}`,
  );
  for (const r of rows.slice(0, n)) {
    console.log(
      `${label(r.config).padEnd(52)} ${pct(r.excess).padStart(8)} ${pct(r.cagr).padStart(8)} ${pct(r.bench).padStart(8)} ` +
        `${String(r.trades).padStart(5)} ${`${r.win.toFixed(0)}%`.padStart(6)} ${`-${r.dd.toFixed(0)}%`.padStart(7)} ` +
        `${`${r.invested.toFixed(0)}%`.padStart(5)}`,
    );
  }
}

function printYears(title: string, row: Row) {
  console.log(`\n${title}`);
  console.log(`  ${"年".padStart(6)} ${"策略".padStart(8)} ${"同池".padStart(8)} ${"超额".padStart(8)} ${"笔".padStart(5)}`);
  for (const y of row.years) {
    console.log(
      `  ${String(y.year).padStart(6)} ${pct(y.strat).padStart(8)} ${pct(y.bench).padStart(8)} ` +
        `${pct(y.strat - y.bench).padStart(8)} ${String(y.trades).padStart(5)}`,
    );
  }
}

function uniqueKey(c: BacktestConfig) {
  return [
    c.requireVegas,
    c.requireRsi,
    c.rpsMin,
    c.stopMult,
    c.trailMult,
    c.takeProfitR,
    c.useBuy2,
    c.rpsWeightPower,
  ].join("|");
}

async function main() {
  const tLoad = Date.now();
  const universe = await loadPreparedUniverse("SMALLFUND", "2h");
  console.log(
    `2H 池 ${universe.symbols.length} 只  轴 ${universe.axis[0]} → ${universe.axis.at(-1)}  ` +
      `载入 ${Date.now() - tLoad}ms`,
  );

  const tOne = Date.now();
  const shared = evalCfg(universe, SMALL_FUND_2H_DEFAULT_CONFIG);
  console.log(`单组 ${Date.now() - tOne}ms  日线/4H平台搬到2H ${label(shared.config)}`);
  console.log(
    `  超额 ${pct(shared.excess)}  年化 ${pct(shared.cagr)} vs ${pct(shared.bench)}  ` +
      `${shared.trades} 笔  回撤 -${shared.dd.toFixed(0)}%`,
  );

  const yesterday = evalCfg(universe, {
    rpsMin: 45,
    stopMult: 4,
    trailMult: 6,
    takeProfitR: 2,
  });

  const coarse: Partial<BacktestConfig>[] = [];
  for (const requireVegas of [false, true]) {
    for (const requireRsi of [false, true]) {
      for (const rpsMin of [0, 35, 45, 55]) {
        for (const trailMult of [2, 5.5, 6, 8]) {
          for (const takeProfitR of [null, 1, 2] as const) {
            coarse.push({
              requireVegas,
              requireRsi,
              rpsMin,
              stopMult: 4,
              trailMult,
              takeProfitR,
            });
          }
        }
      }
    }
  }

  console.log(`\n粗扫 ${coarse.length} 组`);
  const t0 = Date.now();
  const coarseRows = coarse.map((g, i) => {
    if ((i + 1) % 20 === 0) {
      process.stdout.write(`\r粗扫 ${i + 1}/${coarse.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
    }
    return evalCfg(universe, g);
  });
  console.log(`\n粗扫完 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const coarseOk = coarseRows.filter((r) => r.trades >= MIN_TRADES).sort((a, b) => b.excess - a.excess);
  print(`粗扫超额最高（≥${MIN_TRADES} 笔，${coarseOk.length}/${coarseRows.length}）`, coarseOk, 12);

  const seed = coarseOk[0]?.config ?? shared.config;
  const refine: Partial<BacktestConfig>[] = [];
  for (const rpsMin of [30, 35, 40, 45, 50, 55]) {
    for (const stopMult of [3, 4, 6]) {
      for (const trailMult of [4, 5.5, 6, 7, 8]) {
        for (const takeProfitR of [null, 1, 1.5, 2, 3] as const) {
          refine.push({
            requireVegas: false,
            requireRsi: false,
            rpsMin,
            stopMult,
            trailMult,
            takeProfitR,
          });
        }
      }
    }
  }
  for (const rpsWeightPower of [null, 0.5, 1, 2] as const) {
    refine.push({
      requireVegas: false,
      requireRsi: false,
      rpsMin: seed.rpsMin,
      stopMult: seed.stopMult,
      trailMult: seed.trailMult,
      takeProfitR: seed.takeProfitR,
      rpsWeightPower,
    });
  }

  const seen = new Set<string>();
  const refineUnique = refine.filter((g) => {
    const key = uniqueKey(base(g));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n细扫 ${refineUnique.length} 组（闸门关）`);
  const t1 = Date.now();
  const refineRows = refineUnique.map((g, i) => {
    if ((i + 1) % 20 === 0) {
      process.stdout.write(`\r细扫 ${i + 1}/${refineUnique.length}  ${((Date.now() - t1) / 1000).toFixed(0)}s   `);
    }
    return evalCfg(universe, g);
  });
  console.log(`\n细扫完 ${((Date.now() - t1) / 1000).toFixed(0)}s`);

  const refineOk = refineRows.filter((r) => r.trades >= MIN_TRADES).sort((a, b) => b.excess - a.excess);
  print(`细扫超额最高（≥${MIN_TRADES} 笔，${refineOk.length}/${refineRows.length}）`, refineOk, 20);
  console.log(`细扫正超额 ${refineOk.filter((r) => r.excess > 0).length}/${refineOk.length}`);

  const peak = refineOk[0] ?? shared;
  printYears(`日线平台搬到 2H  ${label(shared.config)}`, shared);
  printYears(`昨天4H组搬到 2H  ${label(yesterday.config)}`, yesterday);
  printYears(`尖峰  ${label(peak.config)}`, peak);

  console.log(`\n邻域（相对尖峰只动一轴）`);
  const axes: { name: string; key: keyof BacktestConfig; values: Array<number | boolean | null> }[] = [
    { name: "RPS", key: "rpsMin", values: [30, 35, 40, 45, 50, 55, 60] },
    { name: "止损", key: "stopMult", values: [3, 4, 6, 8] },
    { name: "吊灯", key: "trailMult", values: [4, 5, 5.5, 6, 7, 8] },
    { name: "止盈", key: "takeProfitR", values: [null, 1, 1.5, 2, 3] },
    { name: "k", key: "rpsWeightPower", values: [null, 0.5, 1, 2] },
    { name: "Vegas", key: "requireVegas", values: [false, true] },
  ];
  for (const axis of axes) {
    const cells = axis.values.map((v) => evalCfg(universe, { ...peak.config, [axis.key]: v }));
    console.log(
      `  ${axis.name.padEnd(6)} ` +
        cells.map((r) => `${String(r.config[axis.key] ?? "空")}:${pct(r.excess)}`).join("  "),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
