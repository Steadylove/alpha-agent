import { formatIndustryLabel } from "@/lib/i18n/gicsZh";
import { mapSectorToClock } from "@/lib/scoring/sectorUniverse";

import { EXTRA_SECTORS } from "./extraSectors";
import type { OpportunityStock } from "./types";
import { rpsDelta } from "./velocityOf";

export type RankedLite = {
  symbol: string;
  name?: string;
  sector: string | null;
  industry: string | null;
  industryLabel?: string;
  rps: { 20: number; 50: number; 120: number; 250: number };
  prevRps250?: number | null;
  elite?: boolean;
  newHigh?: boolean;
};

export function overlayPool(members: readonly string[], ranked: readonly RankedLite[]): OpportunityStock[] {
  const bySym = new Map(ranked.map((r) => [r.symbol, r]));
  return members.map((symbol) => {
    const hit = bySym.get(symbol);
    const extra = EXTRA_SECTORS[symbol];
    const sector = hit?.sector ?? extra?.sector ?? null;
    const industry = hit?.industry ?? extra?.industry ?? null;
    const sectorId = sector ? mapSectorToClock(sector) : extra ? mapSectorToClock(extra.sector) : null;
    return {
      symbol,
      name: hit?.name ?? symbol,
      sectorId,
      industryLabel:
        sector || industry ? hit?.industryLabel || formatIndustryLabel(sector, industry) : "未分类",
      rps20: hit?.rps[20] ?? null,
      rps50: hit?.rps[50] ?? null,
      rps120: hit?.rps[120] ?? null,
      rps250: hit?.rps[250] ?? null,
      rpsDelta: rpsDelta(hit?.rps[250], hit?.prevRps250),
      inLivePool: true,
      elite: Boolean(hit?.elite),
      newHigh: Boolean(hit?.newHigh),
    };
  });
}

function stockOf(r: RankedLite, pool: ReadonlySet<string>): OpportunityStock {
  return {
    symbol: r.symbol,
    name: r.name ?? r.symbol,
    sectorId: r.sector ? mapSectorToClock(r.sector) : null,
    industryLabel: r.industryLabel || formatIndustryLabel(r.sector, r.industry) || "未分类",
    rps20: r.rps[20],
    rps50: r.rps[50],
    rps120: r.rps[120],
    rps250: r.rps[250],
    rpsDelta: rpsDelta(r.rps[250], r.prevRps250),
    inLivePool: pool.has(r.symbol),
    elite: Boolean(r.elite),
    newHigh: Boolean(r.newHigh),
  };
}

export function universeOf(ranked: readonly RankedLite[], pool: ReadonlySet<string>): OpportunityStock[] {
  const fromRanked = ranked.map((r) => stockOf(r, pool));
  const have = new Set(fromRanked.map((s) => s.symbol));
  const extras = overlayPool(
    [...pool].filter((s) => !have.has(s)),
    ranked,
  );
  return [...fromRanked, ...extras];
}

export function candidatesOf(ranked: readonly RankedLite[], pool: ReadonlySet<string>): OpportunityStock[] {
  return ranked.filter((r) => r.elite || r.newHigh).map((r) => stockOf(r, pool));
}
