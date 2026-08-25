import { DEFAULT_BACKTEST_CONFIG, runBacktest, type BacktestResult } from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import { SMALL_FUND_DEFAULT_CONFIG } from "@/lib/backtest/smallFundUniverse";
import { getQqqCloses, overlaySpyCurve } from "@/lib/backtest/spyCurve";

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

function print(label: string, result: BacktestResult) {
  const p = result.inSample.portfolio;
  const b = result.inSample.benchmark;
  const ytd = result.ytd;
  console.log(`\n=== ${label} ===`);
  console.log(
    `净值 ${p.equity.toFixed(2)}x  年化 ${pct(p.cagrPct)}  回撤 -${p.maxDrawdownPct.toFixed(1)}%  敞口 ${p.avgExposurePct.toFixed(0)}%`,
  );
  console.log(
    `同池 ${b.equity.toFixed(2)}x  年化 ${pct(b.cagrPct)}  超额年化 ${pct(p.cagrPct - b.cagrPct)}  成交 ${result.inSample.trade.trades}`,
  );
  console.log("年  策略 / 同池 / QQQ");
  for (const row of result.byYear) {
    const qqq = row.spyPct == null ? "—" : pct(row.spyPct);
    console.log(
      `  ${row.year}  ${pct(row.strategyPct)}  /  ${pct(row.benchmarkPct)}  /  ${qqq}   成交 ${row.trades}`,
    );
  }
  if (ytd) {
    const qqq = ytd.spyPct == null ? "—" : pct(ytd.spyPct);
    console.log(`  YTD  ${pct(ytd.strategyPct)}  /  ${pct(ytd.benchmarkPct)}  /  ${qqq}`);
  }
}

async function main() {
  const [universe, qqq] = await Promise.all([
    getPreparedUniverse("SMALLFUND", "1d", "sf-2026-08"),
    getQqqCloses(),
  ]);
  const base = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...SMALL_FUND_DEFAULT_CONFIG,
    timeframe: "1d" as const,
  };

  for (const [label, maxHoldings] of [
    ["不限只数", null],
    ["最多 8 只", 8],
    ["最多 6 只", 6],
  ] as const) {
    const result = runBacktest(universe, { ...base, maxHoldings });
    if (qqq) overlaySpyCurve(result.book, result.byYear, result.ytd, qqq);
    print(label, result);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
