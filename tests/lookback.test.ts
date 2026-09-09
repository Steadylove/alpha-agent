import { describe, expect, it } from "vitest";

import type { DayBook, HoldingDay } from "@/lib/backtest/engine";
import {
  clampLookbackSlots,
  dailyCurve,
  DEFAULT_LOOKBACK_SLOTS,
  fillsOf,
  goodMisses,
  lookbackView,
  winRatePctOf,
  ytdOfCurve,
} from "@/lib/fund/lookbackLogic";

const point = (date: string, strategy: number, over: Partial<DayBook> = {}): DayBook => ({
  date,
  strategy,
  benchmark: 1,
  spy: null,
  nHold: 0,
  exposurePct: 50,
  buys: [],
  sells: [],
  ...over,
});

describe("lookback", () => {
  it("胜率只看已平仓，没有单就是空", () => {
    expect(winRatePctOf([])).toBeNull();
    expect(winRatePctOf([1.2, -0.4, 3])).toBeCloseTo(66.666, 2);
    expect(lookbackView({ book: [point("2026-01-02T17:30", 1.1)], holdings: [], lotPnl: [{ pct: 2 }, { pct: -1 }] }, "2026-01-01").stats.winRatePct).toBe(50);
  });

  it("最多持仓默认 10，只接受 1–20 的整数", () => {
    expect(DEFAULT_LOOKBACK_SLOTS).toBe(10);
    expect(clampLookbackSlots(10)).toBe(10);
    expect(clampLookbackSlots("8")).toBe(8);
    expect(clampLookbackSlots(0)).toBeNull();
    expect(clampLookbackSlots(21)).toBeNull();
    expect(clampLookbackSlots(10.5)).toBeNull();
  });

  it("4H 多根收成每日最后净值，并带上当天持仓", () => {
    const holdings: HoldingDay[] = [
      {
        date: "2026-01-02T17:30",
        rows: [
          {
            symbol: "AAPL",
            weightPct: 12.5,
            sigType: 1,
            entryDate: "2026-01-02",
            entryPrice: 10,
            floatPnlPct: 1,
            entryRps: 70,
            rps: 70,
          },
        ],
      },
    ];
    expect(
      dailyCurve(
        [point("2026-01-02T09:30", 1.01), point("2026-01-02T17:30", 1.02), point("2026-01-05T17:30", 1.05)],
        holdings,
      ),
    ).toEqual([
      {
        date: "2026-01-02",
        equity: 1.02,
        exposurePct: 50,
        rows: [{ symbol: "AAPL", floatPnlPct: 1, entryPrice: 10, weightPct: 12.5, rps: 70, entryDate: "2026-01-02" }],
        buys: [],
        sells: [],
        misses: [],
      },
      { date: "2026-01-05", equity: 1.05, exposurePct: 50, rows: [], buys: [], sells: [], misses: [] },
    ]);
  });

  it("快照用最后一天持仓和累计盈利", () => {
    const holdings: HoldingDay[] = [
      {
        date: "2026-01-05T17:30",
        rows: [
          {
            symbol: "NVDA",
            weightPct: 12.5,
            sigType: 1,
            entryDate: "2026-01-02",
            entryPrice: 100,
            floatPnlPct: 10,
            entryRps: 80,
            rps: 82,
          },
        ],
      },
    ];
    const view = lookbackView(
      { book: [point("2026-01-02T17:30", 1.1), point("2026-01-05T17:30", 1.2)], holdings },
      "2026-01-01",
    );
    expect(view.since).toBe("2026-01-01");
    expect(view.asOf).toBe("2026-01-05T17:30");
    expect(view.pnl).toBe("+20.0%");
    expect(view.rows).toEqual([
      { symbol: "NVDA", floatPnlPct: 10, entryPrice: 100, weightPct: 12.5, rps: 82, entryDate: "2026-01-02" },
    ]);
    expect(view.stats.ytdYear).toBe(2026);
    expect(view.stats.ytdPct).toBeCloseTo(20);
    expect(view.fills).toEqual([
      { date: "2026-01-02", side: "buy", symbol: "NVDA", price: 100 },
    ]);
  });

  it("成交是已平仓买卖加上仍持有的开仓", () => {
    expect(
      fillsOf(
        [
          {
            symbol: "AAPL",
            entryDate: "2026-01-02T13:30",
            entryPrice: 10,
            exitDate: "2026-01-05T17:30",
            exitPrice: 11,
            pnlPct: 10,
            exitReason: "stop",
          },
        ],
        [
          {
            symbol: "NVDA",
            weightPct: 10,
            sigType: 1,
            entryDate: "2026-01-08T15:30",
            entryPrice: 100,
            floatPnlPct: 2,
            entryRps: 80,
          },
        ],
      ),
    ).toEqual([
      { date: "2026-01-02T13:30", side: "buy", symbol: "AAPL", price: 10 },
      { date: "2026-01-05T17:30", side: "sell", symbol: "AAPL", price: 11, pnlPct: 10, reason: "stop" },
      { date: "2026-01-08T15:30", side: "buy", symbol: "NVDA", price: 100 },
    ]);
  });

  it("同一天多根的买卖合成当日轮换", () => {
    const curve = dailyCurve([
      point("2026-01-02T09:30", 1.0, { buys: ["AAPL"], sells: ["MSFT"] }),
      point("2026-01-02T17:30", 1.02, { buys: ["NVDA"], sells: ["MSFT"] }),
    ]);
    expect(curve[0].buys).toEqual(["AAPL", "NVDA"]);
    expect(curve[0].sells).toEqual(["MSFT"]);
  });

  it("YTD 用去年最后一天净值作基数", () => {
    const curve = dailyCurve([
      point("2025-12-31T17:30", 1.1),
      point("2026-01-02T17:30", 1.21),
      point("2026-09-04T17:30", 1.32),
    ]);
    const ytd = ytdOfCurve(curve);
    expect(ytd?.year).toBe(2026);
    expect(ytd?.pct).toBeCloseTo(20);
  });

  it("只标第一次错过、且期末涨得比当天净值多的票", () => {
    const curve = dailyCurve([point("2026-01-02T17:30", 1.0), point("2026-09-04T17:30", 0.97)]);
    expect(
      goodMisses(
        [
          { date: "2026-01-02T17:30", symbol: "NVDA", price: 100 },
          { date: "2026-03-01T17:30", symbol: "NVDA", price: 90 },
          { date: "2026-01-02T17:30", symbol: "HOOD", price: 50 },
        ],
        new Map([
          ["NVDA", 150],
          ["HOOD", 45],
        ]),
        curve,
      ),
    ).toEqual([{ date: "2026-01-02", symbol: "NVDA", laterPct: 50 }]);
  });
});
