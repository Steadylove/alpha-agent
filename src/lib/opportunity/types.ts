import type { SectorClockStatus } from "@/lib/scoring/sectorClock";
import type { SectorClockId } from "@/lib/scoring/sectorUniverse";

export type OpportunitySectorRow = {
  id: SectorClockId;
  symbol: string;
  name: string;
  rank: number;
  status: SectorClockStatus;
  sls: number;
  mom21: number;
  /** 11 档里的 63 日强弱分位，0–100 */
  rps: number;
  rpsDelta: number | null;
  breadth: { sample: number; strong: number; rising: number } | null;
};

export type OpportunityStock = {
  symbol: string;
  name: string;
  sectorId: SectorClockId | null;
  industryLabel: string;
  rps20: number | null;
  rps50: number | null;
  rps120: number | null;
  rps250: number | null;
  rpsDelta: number | null;
  inLivePool: boolean;
  elite: boolean;
  newHigh: boolean;
};

export type OpportunityData = {
  asOf: string | null;
  missingSymbols: string[];
  sectors: OpportunitySectorRow[];
  leaders: SectorClockId[];
  bottoming: SectorClockId[];
  pool: OpportunityStock[];
  candidates: OpportunityStock[];
};

export function emptyOpportunity(): OpportunityData {
  return {
    asOf: null,
    missingSymbols: [],
    sectors: [],
    leaders: [],
    bottoming: [],
    pool: [],
    candidates: [],
  };
}
