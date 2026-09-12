import { buildClockSnapshot } from "@/lib/opportunity/clockSnapshot";
import { mergeScreener } from "@/lib/opportunity/mergeScreener";
import { emptyOpportunity, type OpportunityData } from "@/lib/opportunity/types";
import type { RankedScreener } from "@/lib/jobs/alphaScreener";
import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";
import { readSignalPoolMembers } from "@/lib/fund/signalPool";
import { loadDailyBars } from "@/lib/vps/loadDailyBars";
import { readSnapshot, writeSnapshot } from "@/lib/vps/snapshot";

const CLOCK_SYMBOLS = ["SPY", ...SECTOR_UNIVERSE.map((s) => s.symbol)];

export async function runOpportunityJob(): Promise<OpportunityData> {
  const loaded = await loadDailyBars(CLOCK_SYMBOLS);
  const clock = buildClockSnapshot(loaded);
  const screener = await readSnapshot<{ ranked?: RankedScreener[] }>("screener");
  const members = await readSignalPoolMembers().catch(() => [] as string[]);
  const snapshot = mergeScreener(clock, screener?.ranked, members);
  writeSnapshot("opportunity", snapshot);
  return snapshot;
}

export function opportunityJobResult(data: OpportunityData) {
  return {
    asOf: data.asOf,
    missing: data.missingSymbols.length,
    sectors: data.sectors.length,
    leaders: data.leaders,
  };
}

export { emptyOpportunity };
