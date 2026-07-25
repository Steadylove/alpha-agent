import { sectorEtfs, stockUniverse } from "@/lib/fixtures/universe";
import { percentileRank } from "@/lib/scoring/indicators";
import { scoreMacroSafety } from "@/lib/scoring/macro";
import { scoreSectors } from "@/lib/scoring/sector";
import { scoreStocks } from "@/lib/scoring/stock";
import { describe, expect, it } from "vitest";
import { makeBars } from "./helpers";

describe("scoring engine", () => {
  it("computes O'Neil RPS as (1 - rank/N) × 100", () => {
    // 模拟 5 只：涨幅 [0.5, 0.4, 0.3, 0.2, 0.1]，第 2 名（0.4）→ rank=2 → (1-2/5)*100=60
    const universe = [0.5, 0.4, 0.3, 0.2, 0.1];
    expect(percentileRank(0.4, universe)).toBeCloseTo(60, 5);
    // 第 1 名
    expect(percentileRank(0.5, universe)).toBeCloseTo(80, 5);
    // 末名
    expect(percentileRank(0.1, universe)).toBeCloseTo(0, 5);
  });

  it("ranks stronger sector ETFs above weaker ones", () => {
    const barsBySymbol = new Map([
      ["SPY", makeBars("SPY", 100, 0.1)],
      ["XLK", makeBars("XLK", 100, 0.6)],
      ["XLF", makeBars("XLF", 100, 0.2)],
      ["XLE", makeBars("XLE", 100, -0.1)],
    ]);

    const scores = scoreSectors(
      sectorEtfs.filter((item) => ["SPY", "XLK", "XLF", "XLE"].includes(item.symbol)),
      barsBySymbol,
    );

    expect(scores[0].symbol).toBe("XLK");
    expect(scores[0].rank).toBe(1);
  });

  it("scores stocks and returns ranked candidates", () => {
    const candidates = stockUniverse.slice(0, 3).map((instrument, index) => ({
      instrument,
      bars: makeBars(instrument.symbol, 100, 0.2 + index * 0.2),
      fundamentals: {
        symbol: instrument.symbol,
        revenueGrowth: 0.3,
        grossMargin: 0.5,
        fcfMargin: null,
        roic: 0.2,
        epsRevisionRate: 0.9,
        gmDecliningStreak: 0,
        sharesDilution12m: null,
        marketCap: 2_000_000_000_000,
        adtv20d: null,
        reverseSplit12m: false,
        analystTargetPrice: 250,
      },
    }));

    const scores = scoreStocks(candidates, null);

    expect(scores).toHaveLength(3);
    expect(scores[0].rank).toBe(1);
    expect(scores[0].finalCompassScore).toBeGreaterThanOrEqual(0);
    expect(scores[0].killSwitchStatus === "PASSED" || scores[0].killSwitchStatus === "BLOCKED").toBe(true);
  });

  it("computes macro safety with confidence for missing public data", () => {
    const metric = scoreMacroSafety({
      date: "2026-07-24",
      hygBars: makeBars("HYG", 100, 0.2),
      tltBars: makeBars("TLT", 100, 0.05),
      stockBars: [makeBars("NVDA", 100, 0.2), makeBars("MSFT", 100, -0.1)],
    });

    expect(metric.mss).toBeGreaterThan(0);
    expect(metric.confidence).toBe(0.5);
  });
});
