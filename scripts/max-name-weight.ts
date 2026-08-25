import { DEFAULT_BACKTEST_CONFIG, runBacktest, type HoldingDay } from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import {
  SMALL_FUND_4H_DEFAULT_CONFIG,
  SMALL_FUND_DEFAULT_CONFIG,
} from "@/lib/backtest/smallFundUniverse";

function maxOne(label: string, holdings: HoldingDay[]) {
  let best = { w: 0, symbol: "", date: "", n: 0 };
  for (const h of holdings) {
    for (const r of h.rows) {
      if (r.weightPct > best.w) {
        best = { w: r.weightPct, symbol: r.symbol, date: h.date, n: h.rows.length };
      }
    }
  }
  console.log(`${label}  ${best.symbol}  ${best.date}  ${best.w.toFixed(1)}%  当日${best.n}只`);
}

function lastOfDay(holdings: HoldingDay[]) {
  const m = new Map<string, HoldingDay["rows"]>();
  for (const h of holdings) m.set(h.date.slice(0, 10), h.rows);
  return m;
}

async function main() {
  const [u1, u4] = await Promise.all([
    getPreparedUniverse("SMALLFUND", "1d", "sf-2026-08"),
    getPreparedUniverse("SMALLFUND", "4h", "sf-2026-08"),
  ]);
  const daily = runBacktest(u1, {
    ...DEFAULT_BACKTEST_CONFIG,
    ...SMALL_FUND_DEFAULT_CONFIG,
    timeframe: "1d",
  });
  const hour = runBacktest(u4, {
    ...DEFAULT_BACKTEST_CONFIG,
    ...SMALL_FUND_4H_DEFAULT_CONFIG,
    timeframe: "4h",
  });

  maxOne("日线本账", daily.holdings);
  maxOne("4H本账", hour.holdings);

  const h4 = lastOfDay(hour.holdings);
  const dHold = lastOfDay(daily.holdings);
  for (const [dw, hw, name] of [
    [0.7, 0.3, "袖套70/30"] as const,
    [0.5, 0.5, "袖套50/50"] as const,
  ]) {
    let best = { w: 0, symbol: "", date: "" };
    for (const [day, rows] of dHold) {
      const a = new Map(rows.map((r) => [r.symbol, r.weightPct / 100]));
      const b = new Map((h4.get(day) ?? []).map((r) => [r.symbol, r.weightPct / 100]));
      for (const s of new Set([...a.keys(), ...b.keys()])) {
        const w = dw * (a.get(s) ?? 0) + hw * (b.get(s) ?? 0);
        if (w > best.w) best = { w, symbol: s, date: day };
      }
    }
    console.log(`${name} 占合成净值  ${best.symbol}  ${best.date}  ${(best.w * 100).toFixed(1)}%`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
