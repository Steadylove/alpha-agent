import { mapSectorToClock } from "@/lib/scoring/sectorUniverse";

import { breadthOf } from "./breadthOf";
import { candidatesOf, overlayPool, universeOf, type RankedLite } from "./poolOverlay";
import type { OpportunityData } from "./types";

export function mergeScreener(
  clock: OpportunityData,
  ranked: readonly RankedLite[] | null | undefined,
  members: readonly string[],
): OpportunityData {
  if (!ranked?.length) {
    const pool = overlayPool(members, []);
    return {
      ...clock,
      pool,
      universe: pool,
    };
  }

  const breadth = breadthOf(
    ranked.map((r) => ({
      sectorId: r.sector ? mapSectorToClock(r.sector) : null,
      rps250: r.rps[250],
      rpsDelta: r.prevRps250 == null ? null : r.rps[250] - r.prevRps250,
    })),
  );

  return {
    ...clock,
    sectors: clock.sectors.map((row) => ({ ...row, breadth: breadth[row.id] ?? { sample: 0, strong: 0, rising: 0 } })),
    pool: overlayPool(members, ranked),
    candidates: candidatesOf(ranked, new Set(members)),
    universe: universeOf(ranked, new Set(members)),
  };
}
