import { cashBookSvg } from "@/lib/discord/bookCardImage";
import { daysOpenLabel, daysOpenOf, renderCashBook, sparklineValues, ytdOfNav } from "@/lib/discord/bookCopy";
import { describe, expect, it } from "vitest";

const sample = {
  asOf: "2026-08-21T17:30",
  since: "2021-08-24",
  label: "4 小时",
  exposurePct: 75,
  equity: 1.12,
  cagr: 15.2,
  ytdPct: 8.5,
  ytdYear: 2026,
  dd: 9,
  mar: 12.83,
  avgHoldings: 6.1,
  avgExposure: 62,
  winRatePct: 53,
  rows: [{ symbol: "NVDA", floatPnlPct: 6.2, entryPrice: 170, weightPct: 12.5, rps: 79 }],
};

describe("days open", () => {
  it("按日历日算持仓天数", () => {
    expect(daysOpenOf("2026-08-14", "2026-09-04T17:30")).toBe(21);
    expect(daysOpenLabel(21)).toBe("21天");
    expect(daysOpenOf(null, "2026-09-04")).toBeNull();
  });
});

describe("sparkline", () => {
  it("过长序列抽成固定点数", () => {
    expect(sparklineValues([1, 2, 3], 8)).toEqual([1, 2, 3]);
    expect(sparklineValues([1, 2, 3, 4, 5], 3)).toEqual([1, 3, 5]);
  });
});

describe("ytd of nav", () => {
  it("有去年收盘就用它当基数", () => {
    const ytd = ytdOfNav([
      { date: "2025-12-31T17:30", equity: 1.1 },
      { date: "2026-09-04T17:30", equity: 1.32 },
    ]);
    expect(ytd).toEqual({ year: 2026, pct: expect.closeTo(20) });
  });
});

describe("cash book copy", () => {
  it("每行写该股相对大池分位，不写门槛、RPS、一买二买", () => {
    const msg = renderCashBook(sample);
    const text = JSON.stringify(msg);
    expect(msg.content).toContain("记账自 2021-08-24");
    expect(text).toContain("强于 79%");
    expect(text).toContain("累计盈利");
    expect(text).toContain("CAGR");
    expect(text).toContain("+15.2%");
    expect(text).toContain("回撤");
    expect(text).toContain("MAR");
    expect(text).toContain("均持");
    expect(text).toContain("胜率");
    expect(text).toContain("2026 YTD");
    expect(text).toContain("+12.0%");
    expect(text).toContain("+8.5%");
    expect(text).not.toContain("权益");
    expect(text).not.toContain("强于 30%");
    expect(text).not.toMatch(/RPS|一买|二买/);
  });
});

describe("cash book card", () => {
  it("强度列是每股分位，表头不写门槛", () => {
    const svg = cashBookSvg(sample);
    expect(svg).toContain("记账自 2021-08-24");
    expect(svg).toContain("截至 2026-08-21 13:30 美东时间");
    expect(svg).toContain("累计 +12.0%");
    expect(svg).toContain("仅供信息参考，不构成投资建议");
    expect(svg).toContain("强度");
    expect(svg).toContain("强于 79%");
    expect(svg).toContain("NVDA");
    expect(svg).toContain("+6.2%");
    expect(svg).toContain("170.00");
    expect(svg).toContain("12.5%");
    expect(svg).toContain("累计");
    expect(svg).toContain("CAGR");
    expect(svg).toContain("年化收益");
    expect(svg).toContain("+15.2%");
    expect(svg).toContain("回撤");
    expect(svg).toContain("MAR");
    expect(svg).toContain("12.83");
    expect(svg).toContain("均持");
    expect(svg).toContain("6.1");
    expect(svg).toContain("胜率");
    expect(svg).toContain("53%");
    expect(svg).toContain("62%");
    expect(svg).toContain("2026 YTD");
    expect(svg).toContain("+12.0%");
    expect(svg).toContain("+8.5%");
    expect(svg).not.toContain("权益");
    expect(svg).not.toContain("强于 30%");
    expect(svg).not.toMatch(/RPS|一买|二买|强度超过/);
  });
});
