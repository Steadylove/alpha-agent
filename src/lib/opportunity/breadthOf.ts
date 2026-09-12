import type { SectorClockId } from "@/lib/scoring/sectorUniverse";

export type BreadthInput = {
  sectorId: SectorClockId | null;
  rps250: number;
  rpsDelta: number | null;
};

export type SectorBreadth = { sample: number; strong: number; rising: number };

export function breadthOf(rows: readonly BreadthInput[]): Record<SectorClockId, SectorBreadth> {
  const out = {} as Record<SectorClockId, SectorBreadth>;
  for (const row of rows) {
    if (row.sectorId == null) continue;
    const bucket = out[row.sectorId] ?? { sample: 0, strong: 0, rising: 0 };
    bucket.sample += 1;
    if (row.rps250 >= 80) bucket.strong += 1;
    if (row.rpsDelta != null && row.rpsDelta > 0) bucket.rising += 1;
    out[row.sectorId] = bucket;
  }
  return out;
}
