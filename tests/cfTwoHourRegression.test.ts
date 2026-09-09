import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsvText } from "@/lib/backtest/csvPanel";
import { twoHourBarsFromHourly } from "@/lib/backtest/twoHourPanel";
import { barTimeISO } from "@/lib/data-sources/yahooIntraday";
import { computeRotationTrades, DEFAULT_TRADE_PARAMS } from "@/lib/scoring/rotationTrade";

// 取自项目已有 CF 1H CSV（2026-09-09 读取）。固定网站截图中的那笔开仓，隔离分桶对退出的影响。
describe("CF 2026 年 6 月持仓退出回归", () => {
  it("标准 2H 会在 8 月 6 日触发吊灯退出，末半小时不再混入前一根", () => {
    const hourly = parseCsvText("CF", readFileSync(new URL("./fixtures/cf-1h-2026.csv", import.meta.url), "utf8"))!;
    const bars = twoHourBarsFromHourly(hourly).map((b) => ({ ...b, date: barTimeISO(b.timestamp) }));
    const entry = bars.findIndex((b) => b.date === "2026-06-10T17:30");
    const result = computeRotationTrades("CF", bars, bars.map((_, i) => i === entry - 1), bars.map(() => false), bars.map(() => 100),
      { ...DEFAULT_TRADE_PARAMS, stopMult: 6, trailMult: 8, minRs: 0 });
    const closed = result.closed[0];
    expect(closed).toMatchObject({ entryDate: "2026-06-10T17:30", exitDate: "2026-08-06T15:30", exitReason: "stop" });
    expect(closed.entryPrice).toBeCloseTo(109.04, 2);
    expect(closed.exitPrice).toBeCloseTo(112.15, 2);
    expect(result.days.at(-1)?.sigType).toBe(0);
    const idx = bars.findIndex((b) => b.date === "2026-08-05T17:30");
    expect(bars[idx].close).toBeCloseTo(116.38, 2);
    expect(bars[idx + 1].date).toBe("2026-08-05T19:30");
    expect(bars[idx + 1].close).toBeCloseTo(115.94, 2);
  });
});
