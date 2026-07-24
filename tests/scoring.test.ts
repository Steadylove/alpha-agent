import { sectorEtfs, stockUniverse } from "@/lib/fixtures/universe";
import { scoreMacroSafety } from "@/lib/scoring/macro";
import { scoreSectors } from "@/lib/scoring/sector";
import { scoreStocks } from "@/lib/scoring/stock";
import { describe, expect, it } from "vitest";
import { makeBars } from "./helpers";

describe("scoring engine", () => {
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
    const sectors = [{ symbol: "XLK", name: "Technology", rs21: 0.1, rs63: 0.2, score: 100, rank: 1 }];
    const candidates = stockUniverse.slice(0, 3).map((instrument, index) => ({
      instrument,
      bars: makeBars(instrument.symbol, 100, 0.2 + index * 0.2),
      fundamentals: {
        symbol: instrument.symbol,
        revenueGrowth: 0.3,
        grossMargin: 0.5,
        epsRevisionRate: 0.9,
      },
    }));

    const scores = scoreStocks(candidates, sectors);

    expect(scores).toHaveLength(3);
    expect(scores[0].rank).toBe(1);
    expect(scores[0].totalScore).toBeGreaterThan(0);
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
