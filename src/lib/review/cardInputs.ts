import type { DailyReview } from "./types";
import type { OptionsMapBar, OptionsMapProfile } from "@/lib/discord/optionsMapCardImage";
import { validReviewDate } from "./store";

export function parseReviewBars(csv: string): OptionsMapBar[] {
  const [head, ...lines] = csv.trim().split(/\r?\n/), columns = head.split(",");
  const keys = ["date", "open", "high", "low", "close"] as const;
  if (keys.some(k => !columns.includes(k))) throw new Error("SPX CSV 缺少 OHLC 列");
  const bars = lines.map(line => {
    const values = line.split(",");
    return Object.fromEntries(keys.map(k => [k, k === "date" ? values[columns.indexOf(k)]?.slice(0, 10) : Number(values[columns.indexOf(k)])])) as OptionsMapBar;
  });
  if (bars.some((b, i) => !validReviewDate(b.date) || (i > 0 && bars[i - 1].date >= b.date) || ![b.open, b.high, b.low, b.close].every(n => Number.isFinite(n) && n > 0) || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close))) throw new Error("SPX OHLC 无效或日期重复");
  return bars;
}

export function validateReviewCards(review: DailyReview, bars: OptionsMapBar[], profile: OptionsMapProfile, expected: { date: string; next: string }) {
  if (review.version !== 1 || review.date !== expected.date || review.tomorrow?.date !== expected.date || review.tomorrow.targetDate !== expected.next) throw new Error("复盘或下一交易日未更新，停止发图");
  for (const symbol of ["SPX", "SPY", "QQQ", "IWM"]) {
    const row = review.options.find(r => r.symbol === symbol)?.today;
    if (row?.as_of?.slice(0, 10) !== expected.date || !Number.isFinite(row.spot) || !Number.isFinite(row.net_gex) || !row.contracts_used) throw new Error(`${symbol} 期权快照缺失或过期`);
    const quote = review.market.metrics.find(m => m.symbol === symbol);
    if (!Number.isFinite(quote?.today)) throw new Error(`${symbol} 收盘行情缺失`);
  }
  if (bars.filter(b => b.date <= expected.date).at(-1)?.date !== expected.date) throw new Error("日线没有覆盖复盘日期");
  const spx = review.options.find(r => r.symbol === "SPX")!;
  if (profile.date !== expected.date || profile.asOf !== spx.today!.as_of || profile.method !== spx.meta?.method_version || profile.dte !== spx.dte) throw new Error("Gamma 分布与复盘口径不一致");
  if (!Array.isArray(profile.rows) || !profile.rows.length || profile.rows.some(r => ![r.strike, r.call_gex, r.put_gex, r.net_gex].every(Number.isFinite) || Math.abs(r.call_gex - r.put_gex - r.net_gex) > 1)) throw new Error("Gamma 分布字段无效");
  const total = profile.rows.reduce((sum, r) => sum + r.net_gex, 0);
  if (!Number.isFinite(profile.netGex) || !Number.isFinite(profile.spot) || Math.abs(total - profile.netGex) > 100 || Math.abs(profile.netGex - spx.today!.net_gex!) > 100 || Math.abs(profile.spot - spx.today!.spot) > .01) throw new Error("Gamma 分布与快照汇总不一致");
}
