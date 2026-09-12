import { percentileRank } from "@/lib/scoring/indicators";
import { sectorStanding, type SectorClockDay } from "@/lib/scoring/sectorClock";
import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";

import type { OpportunitySectorRow } from "./types";

export function clockOf(day: SectorClockDay, prev: SectorClockDay | null = null): OpportunitySectorRow[] {
  const sls = SECTOR_UNIVERSE.map((etf) => day.scores[etf.id]);
  const prevSls = prev ? SECTOR_UNIVERSE.map((etf) => prev.scores[etf.id]) : null;

  return SECTOR_UNIVERSE.map((etf) => {
    const standing = sectorStanding(day, etf.id);
    const rps = percentileRank(standing.sls, sls);
    const prevRps = prev && prevSls ? percentileRank(prev.scores[etf.id], prevSls) : null;
    return {
      id: etf.id,
      symbol: etf.symbol,
      name: etf.name,
      rank: standing.rank,
      status: standing.status,
      sls: standing.sls,
      mom21: standing.mom21,
      rps,
      rpsDelta: prevRps == null ? null : rps - prevRps,
      breadth: null,
    };
  }).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}
