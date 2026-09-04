import { lastSettledNyDate, mergeNewBars } from "@/lib/backtest/mergeBars";
import { describe, expect, it } from "vitest";

describe("mergeNewBars", () => {
  const old = [
    { date: "2026-08-20", open: 1, high: 1, low: 1, close: 1, volume: 10 },
    { date: "2026-08-21", open: 2, high: 2, low: 2, close: 2, volume: 20 },
  ];

  it("只追加 until 之前的新日期", () => {
    const incoming = [
      { date: "2026-08-21", open: 9, high: 9, low: 9, close: 9, volume: 99 },
      { date: "2026-08-22", open: 3, high: 3, low: 3, close: 3, volume: 30 },
      { date: "2026-09-04", open: 4, high: 4, low: 4, close: 4, volume: 40 },
    ];
    const merged = mergeNewBars(old, incoming, "2026-09-03");
    expect(merged.map((b) => b.date)).toEqual(["2026-08-20", "2026-08-21", "2026-08-22"]);
    expect(merged[1]?.close).toBe(2);
  });

  it("盘中棒按日历日截断，当天的 4H 留得下", () => {
    const existing = [
      { date: "2026-08-21T17:30", open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    const incoming = [
      { date: "2026-09-03T13:30", open: 2, high: 2, low: 2, close: 2, volume: 2 },
      { date: "2026-09-03T17:30", open: 3, high: 3, low: 3, close: 3, volume: 3 },
      { date: "2026-09-04T13:30", open: 4, high: 4, low: 4, close: 4, volume: 4 },
    ];
    expect(mergeNewBars(existing, incoming, "2026-09-03").map((b) => b.date)).toEqual([
      "2026-08-21T17:30",
      "2026-09-03T13:30",
      "2026-09-03T17:30",
    ]);
  });

  it("没有新日期时返回原序列", () => {
    const merged = mergeNewBars(old, old, "2026-09-03");
    expect(merged).toEqual(old);
  });
});

describe("lastSettledNyDate", () => {
  it("收盘前用前一个日历日", () => {
    expect(lastSettledNyDate(new Date("2026-09-04T14:00:00-04:00"))).toBe("2026-09-03");
  });

  it("16:15 之后算当天已收盘", () => {
    expect(lastSettledNyDate(new Date("2026-09-04T16:15:00-04:00"))).toBe("2026-09-04");
  });
});
