import { mergeScreener } from "@/lib/opportunity/mergeScreener";
import { emptyOpportunity, type OpportunityData } from "@/lib/opportunity/types";
import type { RankedLite } from "@/lib/opportunity/poolOverlay";
import { readSnapshot } from "@/lib/vps/snapshot";

export async function getOpportunityData(): Promise<OpportunityData> {
  const [raw, screener] = await Promise.all([
    readSnapshot<OpportunityData>("opportunity"),
    readSnapshot<{ ranked?: RankedLite[] }>("screener"),
  ]);
  const data = raw ?? emptyOpportunity();
  if (data.universe?.length) return data;
  const members = data.pool.map((p) => p.symbol);
  if (!screener?.ranked?.length) return { ...emptyOpportunity(), ...data, universe: data.universe ?? [] };
  return mergeScreener(data, screener.ranked, members);
}
