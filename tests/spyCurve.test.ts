import { describe, expect, it } from "vitest";

import type { DayBook, YearRow, YearToDate } from "@/lib/backtest/engine";
import { overlaySpyCurve } from "@/lib/backtest/spyCurve";

const day = (date: string, extras: Partial<DayBook> = {}): DayBook => ({
  date,
  strategy: 1,
  benchmark: 1,
  spy: null,
  nHold: 0,
  exposurePct: 0,
  buys: [],
  sells: [],
  ...extras,
});

describe("overlaySpyCurve", () => {
  it("以窗口前一交易日为 1，分年用上年最后一日切", () => {
    const closes = new Map([
      ["2024-12-31", 100],
      ["2025-01-02", 110],
      ["2025-06-30", 121],
      ["2026-01-02", 133.1],
    ]);
    const book = [
      day("2025-01-02"),
      day("2025-06-30"),
      day("2026-01-02"),
    ];
    const byYear: YearRow[] = [
      { year: 2025, trades: 0, strategyPct: 0, benchmarkPct: 0, spyPct: null, isOutOfSample: false },
      { year: 2026, trades: 0, strategyPct: 0, benchmarkPct: 0, spyPct: null, isOutOfSample: false },
    ];
    const ytd: YearToDate = {
      year: 2026,
      from: "2026-01-02",
      to: "2026-01-02",
      strategyPct: 0,
      benchmarkPct: 0,
      spyPct: null,
      trades: 0,
    };

    overlaySpyCurve(book, byYear, ytd, closes);

    expect(book[0].spy).toBeCloseTo(1.1, 8);
    expect(book[1].spy).toBeCloseTo(1.21, 8);
    expect(book[2].spy).toBeCloseTo(1.331, 8);
    expect(byYear[0].spyPct).toBeCloseTo(21, 8);
    expect(byYear[1].spyPct).toBeCloseTo(10, 8);
    expect(ytd.spyPct).toBeCloseTo(10, 8);
  });
});
