import { describe, expect, it } from "vitest";

import type { DayBook, HoldingDay } from "@/lib/backtest/engine";
import { champOf, CHAMPS } from "@/lib/fund/champs";
import { byYearOf, collapseBookDaily, collapseHoldingsDaily, ytdOf } from "@/lib/fund/frozenLab";

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

describe("四周期定档", () => {
  it("默认 4H，195 四档仍在，扩池 4H/2H 另挂", () => {
    expect(champOf(null).id).toBe("4h");
    expect(champOf("nope").id).toBe("4h");
    expect(CHAMPS.map((c) => c.id)).toEqual(["4h", "4h-broad", "2h", "2h-broad", "1d", "1h"]);
    expect(champOf("4h").poolId).toBe("sf-2026-08");
    expect(champOf("4h-broad").poolId).toBe("sf-broad");
    expect(champOf("4h-broad").config).toMatchObject({
      timeframe: "4h",
      stopMult: 8,
      trailMult: 6,
      takeProfitR: 3,
      rpsMin: 30,
      requireRsi: true,
      minRsi: 30,
      rpsExit: null,
    });
    expect(champOf("4h-broad").opts).toMatchObject({
      slotPct: 0.125,
      entryWindow: "dayClose",
      exitWindow: "all",
    });
    expect(champOf("2h-broad").poolId).toBe("sf-broad");
    expect(champOf("2h-broad").config).toMatchObject({
      timeframe: "2h",
      stopMult: 6,
      trailMult: 8,
      takeProfitR: null,
      rpsMin: 0,
      requireRsi: true,
      minRsi: 30,
      rpsExit: 10,
    });
    expect(champOf("2h-broad").opts).toMatchObject({
      slotPct: 0.125,
      entryWindow: "all",
      exitWindow: "all",
    });
  });

  it("盘中多根收成日终，买卖合并", () => {
    const book = collapseBookDaily([
      day("2024-03-15T13:30:00Z", { strategy: 1.1, buys: ["AAPL"], nHold: 1 }),
      day("2024-03-15T16:00:00Z", { strategy: 1.2, sells: ["NVDA"], nHold: 2 }),
      day("2024-03-18T16:00:00Z", { strategy: 1.3, nHold: 2 }),
    ]);
    expect(book).toHaveLength(2);
    expect(book[0]).toMatchObject({
      date: "2024-03-15",
      strategy: 1.2,
      buys: ["AAPL"],
      sells: ["NVDA"],
      nHold: 2,
    });
    expect(book[1].date).toBe("2024-03-18");
  });

  it("持仓取当日最后一根", () => {
    const holdings = collapseHoldingsDaily([
      { date: "2024-03-15T13:30:00Z", rows: [{ symbol: "A", weightPct: 8, sigType: 1, entryDate: "2024-01-01", entryPrice: 1, floatPnlPct: 0, entryRps: 80 }] },
      { date: "2024-03-15T16:00:00Z", rows: [{ symbol: "B", weightPct: 8, sigType: 1, entryDate: "2024-02-01", entryPrice: 1, floatPnlPct: 1, entryRps: 70 }] },
    ] satisfies HoldingDay[]);
    expect(holdings).toEqual([
      {
        date: "2024-03-15",
        rows: [{ symbol: "B", weightPct: 8, sigType: 1, entryDate: "2024-02-01", entryPrice: 1, floatPnlPct: 1, entryRps: 70 }],
      },
    ]);
  });

  it("分年与 YTD 按上年收盘切", () => {
    const book = [
      day("2024-12-31", { strategy: 1.1, benchmark: 1.05 }),
      day("2025-01-02", { strategy: 1.21, benchmark: 1.1 }),
      day("2025-06-30", { strategy: 1.32, benchmark: 1.2 }),
    ];
    const trades = [
      { symbol: "A", sigType: 1 as const, entryDate: "2024-06-01", exitDate: "2024-12-01", pnlPct: 10 },
      { symbol: "B", sigType: 1 as const, entryDate: "2025-02-01", exitDate: "2025-03-01", pnlPct: 5 },
    ];
    const years = byYearOf(book, trades);
    expect(years[0].year).toBe(2024);
    expect(years[0].strategyPct).toBeCloseTo(10, 5);
    expect(years[1].strategyPct).toBeCloseTo((1.32 / 1.1 - 1) * 100, 5);
    expect(years[1].trades).toBe(1);

    const ytd = ytdOf(book, trades);
    expect(ytd?.year).toBe(2025);
    expect(ytd?.strategyPct).toBeCloseTo((1.32 / 1.1 - 1) * 100, 5);
    expect(ytd?.trades).toBe(1);
  });
});
