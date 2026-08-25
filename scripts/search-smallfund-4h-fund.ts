import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  type BacktestConfig,
  type PreparedUniverse,
} from "@/lib/backtest/engine";
import { loadPreparedUniverse } from "@/lib/backtest/load";
import {
  SMALL_FUND_4H_DEFAULT_CONFIG,
  SMALL_FUND_4H_FROM,
  SMALL_FUND_DEFAULT_CONFIG,
  SMALL_FUND_TO,
} from "@/lib/backtest/smallFundUniverse";

/**
 * 4H「能做基金」选参：看难年份超额和跨年稳定性，不看 2023/24 尖峰。
 *   npx tsx scripts/search-smallfund-4h-fund.ts
 */

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const HARD = new Set([2022, 2025, 2026]);
const BULL = new Set([2023, 2024]);
const FULL = [2022, 2023, 2024, 2025, 2026];

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
  nBeat: number;
  hardEx: number;
  bullEx: number;
  worstEx: number;
  fund: number;
};

function base(override: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    ...SMALL_FUND_DEFAULT_CONFIG,
    ...SMALL_FUND_4H_DEFAULT_CONFIG,
    from: SMALL_FUND_4H_FROM,
    to: SMALL_FUND_TO,
    timeframe: "4h",
    requireRsi: false,
    requireVegas: false,
    rpsWeightPower: 1,
    useBuy1: true,
    useBuy2: true,
    ...override,
  };
}

function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function evalCfg(universe: PreparedUniverse, override: Partial<BacktestConfig> = {}): Row {
  const config = base(override);
  const r = runBacktest(universe, config);
  const w = r.inSample;
  const years = r.byYear.map((y) => ({
    year: y.year,
    strat: y.strategyPct,
    bench: y.benchmarkPct,
    trades: y.trades,
  }));
  const full = years.filter((y) => FULL.includes(y.year));
  const ex = (y: (typeof years)[number]) => y.strat - y.bench;
  const nBeat = full.filter((y) => ex(y) > 0).length;
  const hardEx = mean(full.filter((y) => HARD.has(y.year)).map(ex));
  const bullEx = mean(full.filter((y) => BULL.has(y.year)).map(ex));
  const worstEx = Math.min(...full.map(ex));
  const excess = w.portfolio.cagrPct - w.benchmark.cagrPct;
  const fund =
    2 * hardEx + 0.4 * bullEx + 0.8 * excess + 0.4 * worstEx - 0.2 * w.portfolio.maxDrawdownPct + 8 * nBeat;
  return {
    config,
    excess,
    cagr: w.portfolio.cagrPct,
    bench: w.benchmark.cagrPct,
    trades: w.trade.trades,
    win: w.trade.winRatePct,
    dd: w.portfolio.maxDrawdownPct,
    invested: w.portfolio.investedDayPct,
    years,
    nBeat,
    hardEx,
    bullEx,
    worstEx,
    fund,
  };
}

const label = (c: BacktestConfig) =>
  `${c.requireVegas ? "Vg开" : "Vg关"} ${c.requireRsi ? "RSI" : "R关"} ` +
    `RPS${String(c.rpsMin).padStart(2)} 止损${c.stopMult} 吊灯${String(c.trailMult).padEnd(3)} ` +
    `止盈${(c.takeProfitR == null ? "无" : `${c.takeProfitR}R`).padEnd(3)} ` +
    `${c.useBuy2 ? "一+二" : "一买"} k=${c.rpsWeightPower ?? "等"}`;

function print(title: string, rows: Row[], n = 12) {
  console.log(`\n${title}`);
  console.log(
    `${"参数".padEnd(52)} ${"基金分".padStart(7)} ${"难年".padStart(8)} ${"超额".padStart(8)} ` +
      `${"年化".padStart(8)} ${"胜年".padStart(4)} ${"最差年".padStart(8)} ${"笔".padStart(5)} ${"回撤".padStart(6)}`,
  );
  for (const r of rows.slice(0, n)) {
    console.log(
      `${label(r.config).padEnd(52)} ${r.fund.toFixed(1).padStart(7)} ${pct(r.hardEx).padStart(8)} ` +
        `${pct(r.excess).padStart(8)} ${pct(r.cagr).padStart(8)} ${String(r.nBeat).padStart(4)} ` +
        `${pct(r.worstEx).padStart(8)} ${String(r.trades).padStart(5)} ${`-${r.dd.toFixed(0)}%`.padStart(6)}`,
    );
  }
}

function printYears(title: string, row: Row) {
  console.log(`\n${title}  分${row.fund.toFixed(1)}  难年${pct(row.hardEx)}  超额${pct(row.excess)}`);
  console.log(`  ${"年".padStart(6)} ${"策略".padStart(8)} ${"同池".padStart(8)} ${"超额".padStart(8)} ${"笔".padStart(5)}`);
  for (const y of row.years) {
    console.log(
      `  ${String(y.year).padStart(6)} ${pct(y.strat).padStart(8)} ${pct(y.bench).padStart(8)} ` +
        `${pct(y.strat - y.bench).padStart(8)} ${String(y.trades).padStart(5)}`,
    );
  }
}

function keyOf(c: BacktestConfig) {
  return [c.requireVegas, c.requireRsi, c.rpsMin, c.stopMult, c.trailMult, c.takeProfitR, c.useBuy2, c.rpsWeightPower].join("|");
}

async function main() {
  const universe = await loadPreparedUniverse("SMALLFUND", "4h");
  console.log(`4H 池 ${universe.symbols.length}  轴 ${universe.axis[0]} → ${universe.axis.at(-1)}`);

  const current = evalCfg(universe, SMALL_FUND_4H_DEFAULT_CONFIG);
  printYears("当前默认", current);

  const grid: Partial<BacktestConfig>[] = [];
  for (const rpsMin of [30, 35, 40, 45, 50, 55]) {
    for (const stopMult of [3, 4, 6]) {
      for (const trailMult of [4, 5, 5.5, 6, 7, 8]) {
        for (const takeProfitR of [null, 1, 1.5, 2, 3] as const) {
          grid.push({ rpsMin, stopMult, trailMult, takeProfitR });
        }
      }
    }
  }

  console.log(`\n主网格 ${grid.length} 组`);
  const t0 = Date.now();
  const rows = grid.map((g, i) => {
    if ((i + 1) % 25 === 0) {
      process.stdout.write(`\r网格 ${i + 1}/${grid.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s   `);
    }
    return evalCfg(universe, g);
  });
  console.log(`\n网格完 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const fundable = rows.filter((r) => r.trades >= 180 && r.invested >= 45 && r.dd <= 70);
  const byFund = [...fundable].sort((a, b) => b.fund - a.fund);
  const byHard = [...fundable].sort((a, b) => b.hardEx - a.hardEx);
  const byExcess = [...fundable].sort((a, b) => b.excess - a.excess);

  print("基金分最高（难年加权，≥180笔）", byFund, 15);
  print("难年超额最高", byHard, 8);
  print("整段超额最高（尖峰，勿直接用）", byExcess, 6);

  const seed = byFund[0] ?? current;
  const extra: Partial<BacktestConfig>[] = [];
  for (const rpsWeightPower of [null, 0.5, 1, 2] as const) {
    extra.push({ ...seed.config, rpsWeightPower });
  }
  for (const useBuy2 of [true, false]) extra.push({ ...seed.config, useBuy2 });
  extra.push({ ...seed.config, requireVegas: true });
  extra.push({ ...seed.config, requireRsi: true });

  const seen = new Set(rows.map((r) => keyOf(r.config)));
  const extraRows = extra
    .filter((g) => {
      const k = keyOf(base(g));
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((g) => evalCfg(universe, g));

  print("尖峰邻域：k / 二买 / 闸门", extraRows.sort((a, b) => b.fund - a.fund), 10);

  const pick = [...byFund, ...extraRows.filter((r) => r.trades >= 180)].sort((a, b) => b.fund - a.fund)[0] ?? current;
  printYears("当前默认", current);
  printYears("基金首选", pick);
  if (byExcess[0] && keyOf(byExcess[0].config) !== keyOf(pick.config)) {
    printYears("对照：整段超额尖峰", byExcess[0]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
