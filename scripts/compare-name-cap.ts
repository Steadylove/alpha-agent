import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  type BacktestResult,
  type HoldingRow,
} from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import {
  SMALL_FUND_4H_DEFAULT_CONFIG,
  SMALL_FUND_DEFAULT_CONFIG,
} from "@/lib/backtest/smallFundUniverse";
import { getQqqCloses, getQqqCloses4h, overlaySpyCurve } from "@/lib/backtest/spyCurve";

const CAP = 0.15;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

function cagr(mult: number, years: number) {
  return (mult ** (1 / years) - 1) * 100;
}

function maxDrawdown(equity: number[]) {
  let peak = equity[0] ?? 1;
  let dd = 0;
  for (const x of equity) {
    if (x > peak) peak = x;
    if (peak > 0) dd = Math.max(dd, 1 - x / peak);
  }
  return dd * 100;
}

function lastOfDay<T extends { date: string }>(rows: T[]) {
  const out = new Map<string, T>();
  for (const row of rows) out.set(row.date.slice(0, 10), row);
  return out;
}

function holdingsByDay(result: BacktestResult) {
  const out = new Map<string, HoldingRow[]>();
  for (const h of result.holdings) out.set(h.date.slice(0, 10), h.rows);
  return out;
}

function maxName(result: BacktestResult) {
  let best = { w: 0, symbol: "", date: "" };
  for (const h of result.holdings) {
    for (const r of h.rows) {
      if (r.weightPct > best.w) best = { w: r.weightPct, symbol: r.symbol, date: h.date };
    }
  }
  return best;
}

function yearBreaks(dates: string[], equity: number[], spy: (number | null)[], bench: number[]) {
  const rows: { year: number; strat: number; bench: number; spy: number | null }[] = [];
  for (let i = 0; i < dates.length; ) {
    const year = dates[i].slice(0, 4);
    let j = i;
    while (j < dates.length && dates[j].startsWith(year)) j += 1;
    const prev = i === 0 ? 1 : equity[i - 1];
    const prevB = i === 0 ? 1 : bench[i - 1];
    const prevS = i === 0 ? 1 : (spy[i - 1] ?? 1);
    const endS = spy[j - 1];
    rows.push({
      year: Number(year),
      strat: (equity[j - 1] / prev - 1) * 100,
      bench: (bench[j - 1] / prevB - 1) * 100,
      spy: endS == null ? null : (endS / prevS - 1) * 100,
    });
    i = j;
  }
  return rows;
}

function printBlock(
  label: string,
  dates: string[],
  strat: number[],
  bench: number[],
  spy: (number | null)[],
  extra = "",
) {
  const years = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (365.25 * 86400000);
  const last = strat[strat.length - 1];
  const lastB = bench[bench.length - 1];
  const lastS = spy[spy.length - 1];
  console.log(`\n=== ${label} ===`);
  if (extra) console.log(extra);
  console.log(
    `净值 ${last.toFixed(2)}x  年化 ${pct(cagr(last, years))}  回撤 -${maxDrawdown(strat).toFixed(1)}%`,
  );
  console.log(
    `同池 ${lastB.toFixed(2)}x  年化 ${pct(cagr(lastB, years))}  超额年化 ${pct(cagr(last, years) - cagr(lastB, years))}`,
  );
  if (lastS != null) console.log(`QQQ  ${lastS.toFixed(2)}x  年化 ${pct(cagr(lastS, years))}`);
  console.log("年  策略 / 同池 / QQQ");
  for (const row of yearBreaks(dates, strat, spy, bench)) {
    console.log(
      `  ${row.year}  ${pct(row.strat)}  /  ${pct(row.bench)}  /  ${row.spy == null ? "—" : pct(row.spy)}`,
    );
  }
}

async function main() {
  const [u1, u4, qqq, qqq4] = await Promise.all([
    getPreparedUniverse("SMALLFUND", "1d", "sf-2026-08"),
    getPreparedUniverse("SMALLFUND", "4h", "sf-2026-08"),
    getQqqCloses(),
    getQqqCloses4h(),
  ]);
  const daily = runBacktest(u1, {
    ...DEFAULT_BACKTEST_CONFIG,
    ...SMALL_FUND_DEFAULT_CONFIG,
    timeframe: "1d",
    maxNameWeight: CAP,
  });
  const hour = runBacktest(u4, {
    ...DEFAULT_BACKTEST_CONFIG,
    ...SMALL_FUND_4H_DEFAULT_CONFIG,
    timeframe: "4h",
    maxNameWeight: CAP,
  });
  if (qqq) overlaySpyCurve(daily.book, daily.byYear, daily.ytd, qqq);
  if (qqq4) overlaySpyCurve(hour.book, hour.byYear, hour.ytd, qqq4);

  const dMax = maxName(daily);
  const hMax = maxName(hour);
  console.log(`单票上限 ${CAP * 100}%（超出记现金，默认未改）`);
  console.log(
    `日线最大单票 ${dMax.symbol} ${dMax.date} ${dMax.w.toFixed(1)}%  均敞口 ${daily.inSample.portfolio.avgExposurePct.toFixed(0)}%`,
  );
  console.log(
    `4H最大单票 ${hMax.symbol} ${hMax.date} ${hMax.w.toFixed(1)}%  均敞口 ${hour.inSample.portfolio.avgExposurePct.toFixed(0)}%`,
  );

  printBlock(
    "纯日线 +15%",
    daily.book.map((d) => d.date),
    daily.book.map((d) => d.strategy),
    daily.book.map((d) => d.benchmark),
    daily.book.map((d) => d.spy),
  );
  printBlock(
    "纯4H +15%",
    hour.book.map((d) => d.date),
    hour.book.map((d) => d.strategy),
    hour.book.map((d) => d.benchmark),
    hour.book.map((d) => d.spy),
  );

  const hourBook = lastOfDay(hour.book);
  const dailyHold = holdingsByDay(daily);
  const hourHold = holdingsByDay(hour);

  for (const [dw, hw, label] of [
    [0.7, 0.3, "袖套 70/30（日/4H）"],
    [0.5, 0.5, "袖套 50/50"],
    [0.3, 0.7, "袖套 30/70（日/4H）"],
  ] as const) {
    const dates: string[] = [];
    const strat: number[] = [];
    const bench: number[] = [];
    const spy: (number | null)[] = [];
    let maxCombined = 0;
    let who = "";
    let when = "";
    for (const d of daily.book) {
      const h = hourBook.get(d.date.slice(0, 10));
      if (!h) continue;
      dates.push(d.date.slice(0, 10));
      strat.push(dw * d.strategy + hw * h.strategy);
      bench.push(dw * d.benchmark + hw * h.benchmark);
      spy.push(d.spy != null && h.spy != null ? dw * d.spy + hw * h.spy : (d.spy ?? h.spy));
      const a = new Map((dailyHold.get(d.date.slice(0, 10)) ?? []).map((r) => [r.symbol, r.weightPct / 100]));
      const b = new Map((hourHold.get(d.date.slice(0, 10)) ?? []).map((r) => [r.symbol, r.weightPct / 100]));
      for (const name of new Set([...a.keys(), ...b.keys()])) {
        const w = dw * (a.get(name) ?? 0) + hw * (b.get(name) ?? 0);
        if (w > maxCombined) {
          maxCombined = w;
          who = name;
          when = d.date.slice(0, 10);
        }
      }
    }
    printBlock(
      label,
      dates,
      strat,
      bench,
      spy,
      `合成最大单票 ${who} ${when} ${(maxCombined * 100).toFixed(1)}%`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
