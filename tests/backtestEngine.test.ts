import { describe, expect, it } from "vitest";

import { percentileRanksFast } from "@/lib/backtest/engine";
import { packPanel, unpackPanel } from "@/lib/backtest/panel";
import { deriveIntervals } from "@/lib/data-sources/sp500Historical";
import { percentileRank } from "@/lib/scoring/percentileRs";

describe("percentileRanksFast", () => {
  // 引擎里的排序实现替换了 O(n²) 的 percentileRank，必须逐位等价
  const cases: number[][] = [
    [],
    [7],
    [1, 2, 3],
    [3, 1, 2],
    [5, 5, 5, 5],
    [1, 1, 2, 2, 3],
    [-4, 0, 0, 12, -4, 7],
    [0.1, 0.100000001, 0.1],
  ];

  it.each(cases.map((c, i) => [i, c] as const))("与 percentileRank 等价 (#%i)", (_, scores) => {
    expect(Array.from(percentileRanksFast(scores))).toEqual(percentileRank(scores));
  });

  it("在 500 只的随机截面上等价", () => {
    let seed = 42;
    const scores = Array.from({ length: 500 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      // 制造大量并列，专门压并列分支
      return Math.round((seed / 2147483648) * 20);
    });
    expect(Array.from(percentileRanksFast(scores))).toEqual(percentileRank(scores));
  });
});

describe("成分区间推导", () => {
  const snap = (date: string, tickers: string[]) => ({ date, tickers });

  it("连续出现压成一段，仍在最新快照内则右端为 null", () => {
    const intervals = deriveIntervals([
      snap("2000-01-01", ["AAA", "BBB"]),
      snap("2001-01-01", ["AAA", "BBB"]),
      snap("2002-01-01", ["AAA", "BBB"]),
    ]);
    expect(intervals).toEqual([
      { ticker: "AAA", start: "2000-01-01", end: null },
      { ticker: "BBB", start: "2000-01-01", end: null },
    ]);
  });

  it("中途离开则右端取最后一次出现的快照日", () => {
    const intervals = deriveIntervals([
      snap("2000-01-01", ["AAA", "OUT"]),
      snap("2001-01-01", ["AAA", "OUT"]),
      snap("2002-01-01", ["AAA"]),
    ]);
    expect(intervals.find((i) => i.ticker === "OUT")).toEqual({
      ticker: "OUT",
      start: "2000-01-01",
      end: "2001-01-01",
    });
  });

  it("多次进出产出多段（AMD 那种情形）", () => {
    const intervals = deriveIntervals([
      snap("2000-01-01", ["AMD"]),
      snap("2001-01-01", ["AMD"]),
      snap("2002-01-01", []),
      snap("2003-01-01", []),
      snap("2004-01-01", ["AMD"]),
    ]);
    expect(intervals).toEqual([
      { ticker: "AMD", start: "2000-01-01", end: "2001-01-01" },
      { ticker: "AMD", start: "2004-01-01", end: null },
    ]);
  });
});

describe("面板打包", () => {
  it("往返后日期完整、价格精度足够", () => {
    const bars = [
      { date: "2020-01-02", high: 100.25, low: 99.5, close: 100 },
      { date: "2020-01-03", high: 101.75, low: 100.1, close: 101.5 },
      { date: "2024-12-31", high: 4321.5, low: 4300.25, close: 4310.75 },
    ];
    const packed = packPanel(bars);
    const back = unpackPanel({ ticker: "T", ...packed });

    expect(back.dates).toEqual(bars.map((b) => b.date));
    expect(packed.barCount).toBe(3);
    // Float32 约 7 位有效数字，四位数价格的误差在 0.001 量级
    bars.forEach((b, i) => {
      expect(back.close[i]).toBeCloseTo(b.close, 2);
      expect(back.high[i]).toBeCloseTo(b.high, 2);
      expect(back.low[i]).toBeCloseTo(b.low, 2);
    });
  });
});
