import { describe, expect, it } from "vitest";

import { blendSleeve } from "@/lib/backtest/sleeveBlend";
import type { DayBook, WindowResult } from "@/lib/backtest/engine";

const emptyTrade = {
  trades: 0,
  winRatePct: 0,
  meanPnlPct: 0,
  medianPnlPct: 0,
  profitFactor: 0,
  avgBarsHeld: 0,
  worstPnlPct: 0,
  meanR: 0,
  exits: { stop: 0, target: 0, veto: 0, rsWeak: 0 },
};

const windowOf = (from: string, to: string): WindowResult => ({
  label: "训练区",
  from,
  to,
  trade: emptyTrade,
  portfolio: {
    equity: 1,
    cagrPct: 0,
    maxDrawdownPct: 0,
    volPct: 0,
    investedDayPct: 0,
    avgExposurePct: 0,
    days: 0,
  },
  benchmark: {
    equity: 1,
    cagrPct: 0,
    maxDrawdownPct: 0,
    volPct: 0,
    investedDayPct: 100,
    avgExposurePct: 100,
    days: 0,
  },
});

const day = (date: string, strategy: number, extras: Partial<DayBook> = {}): DayBook => ({
  date,
  strategy,
  benchmark: 1,
  spy: 1,
  nHold: 0,
  exposurePct: 0,
  buys: [],
  sells: [],
  ...extras,
});

describe("blendSleeve", () => {
  it("按 50/50 合成净值", () => {
    const daily = {
      book: [day("2024-01-02", 1.1), day("2024-01-03", 1.21)],
      holdings: [],
      inSample: windowOf("2024-01-02", "2024-01-03"),
      ytd: null,
    };
    const hour = {
      book: [day("2024-01-02T17:30", 1.2), day("2024-01-03T17:30", 1.44)],
      holdings: [],
      inSample: windowOf("2024-01-02", "2024-01-03"),
      ytd: null,
    };
    const blended = blendSleeve(daily, hour);
    expect(blended.book).toHaveLength(2);
    expect(blended.book[0].strategy).toBeCloseTo(1.15, 8);
    expect(blended.book[1].strategy).toBeCloseTo(1.325, 8);
  });
});
