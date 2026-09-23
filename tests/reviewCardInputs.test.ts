import { expect, it } from "vitest";
import { parseReviewBars, validateReviewCards } from "@/lib/review/cardInputs";
import type { DailyReview } from "@/lib/review/types";
import type { OptionsMapProfile } from "@/lib/discord/optionsMapCardImage";

const expected = { date: "2026-09-22", next: "2026-09-23" };
const bars = parseReviewBars("date,open,high,low,close,volume\n2026-09-22,100,102,99,101,1000");
function fixture() {
  const review = { version: 1, date: expected.date, tomorrow: { date: expected.date, targetDate: expected.next }, market: { metrics: ["SPX", "SPY", "QQQ", "IWM"].map(symbol => ({ symbol, today: 101 })) }, options: ["SPX", "SPY", "QQQ", "IWM"].map(symbol => ({ symbol, dte: "0-45d", meta: { method_version: "cboe-gex-v2" }, today: { symbol, as_of: "2026-09-22T16:00:00", spot: 101, net_gex: 1000, contracts_used: 2 } })) } as DailyReview;
  const profile: OptionsMapProfile = { date: expected.date, asOf: "2026-09-22T16:00:00", spot: 101, netGex: 1000, source: "cboe-delayed", method: "cboe-gex-v2", dte: "0-45d", rows: [{ strike: 100, call_gex: 2000, put_gex: 1000, net_gex: 1000 }] };
  return { review, profile };
}
it("禁止把旧复盘、旧期权链和不同汇总的 Gamma 图作为当天数据推送", () => {
  const { review, profile } = fixture();
  expect(() => validateReviewCards(review, bars, profile, expected)).not.toThrow();
  expect(() => validateReviewCards({ ...review, date: "2026-09-21" }, bars, profile, expected)).toThrow("未更新");
  expect(() => validateReviewCards(review, bars, { ...profile, date: "2026-09-21" }, expected)).toThrow("口径");
  expect(() => validateReviewCards(review, bars, { ...profile, netGex: 9000 }, expected)).toThrow("汇总");
  review.options[2].today!.as_of = "2026-09-21T16:00:00";
  expect(() => validateReviewCards(review, bars, profile, expected)).toThrow("QQQ");
});
it("拒绝损坏或重复的 OHLC，不补造 K 线", () => {
  expect(() => parseReviewBars("date,open,high,low,close\n2026-09-22,100,99,98,101")).toThrow("OHLC");
  expect(() => parseReviewBars("date,open,high,low,close\n2026-09-22,100,102,98,101\n2026-09-22,100,102,98,101")).toThrow("日期重复");
});
