import { percentChange, percentileRank } from "@/lib/scoring/indicators";
import type { DailyBar, Instrument, SectorScore } from "@/lib/types/market";

export function scoreSectors(
  sectorEtfs: Instrument[],
  barsBySymbol: Map<string, DailyBar[]>,
  benchmarkSymbol = "SPY",
): SectorScore[] {
  const benchmarkBars = barsBySymbol.get(benchmarkSymbol) ?? [];
  const benchmarkCloses = benchmarkBars.map((bar) => bar.close);
  const benchmark21 = percentChange(benchmarkCloses, 21) ?? 0;
  const benchmark63 = percentChange(benchmarkCloses, 63) ?? 0;

  const raw = sectorEtfs
    .filter((instrument) => instrument.symbol !== benchmarkSymbol && instrument.sector !== "Credit")
    .map((instrument) => {
      const closes = (barsBySymbol.get(instrument.symbol) ?? []).map((bar) => bar.close);
      const rs21 = (percentChange(closes, 21) ?? 0) - benchmark21;
      const rs63 = (percentChange(closes, 63) ?? 0) - benchmark63;
      return {
        symbol: instrument.symbol,
        name: instrument.sector ?? instrument.name,
        rs21,
        rs63,
      };
    });

  const rs21Values = raw.map((item) => item.rs21);
  const rs63Values = raw.map((item) => item.rs63);

  return raw
    .map((item) => {
      const rs21Score = percentileRank(item.rs21, rs21Values);
      const rs63Score = percentileRank(item.rs63, rs63Values);
      return {
        ...item,
        score: Math.round(0.6 * rs21Score + 0.4 * rs63Score),
        rank: 0,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}
