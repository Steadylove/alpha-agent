import type { SectorClockId } from "@/lib/scoring/sectorUniverse";

/** 不在标普名单中的已核验映射；仅决定参照板块，不加入标普广度样本。 */
export const VERIFIED_SECTOR_CLASSIFICATIONS: Record<string, { id: SectorClockId; verifiedAt: string; source: string }> = {
  ALAB: { id: "TECH", verifiedAt: "2026-09-18", source: "https://www.asteralabs.com/about/" },
};
