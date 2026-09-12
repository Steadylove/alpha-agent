import { computeSectorClockSeries } from "@/lib/scoring/sectorClock";
import { SECTOR_UNIVERSE, type SectorClockId } from "@/lib/scoring/sectorUniverse";

import { clockOf } from "./clockOf";
import { emptyOpportunity, type OpportunityData } from "./types";

export type CloseBar = { date: string; close: number };

const NEEDED = 8;

export function buildClockSnapshot(bars: Map<string, CloseBar[]>): OpportunityData {
  const missingSymbols = ["SPY", ...SECTOR_UNIVERSE.map((s) => s.symbol)].filter(
    (s) => (bars.get(s)?.length ?? 0) === 0,
  );
  const spy = bars.get("SPY") ?? [];
  if (spy.length === 0) return { ...emptyOpportunity(), missingSymbols };

  const dates = spy.map((b) => b.date);
  const spyClose = spy.map((b) => b.close);
  const maps = new Map<SectorClockId, Map<string, number>>();
  for (const etf of SECTOR_UNIVERSE) {
    maps.set(etf.id, new Map((bars.get(etf.symbol) ?? []).map((b) => [b.date, b.close])));
  }

  const keep: number[] = [];
  for (let i = 0; i < dates.length; i += 1) {
    const d = dates[i]!;
    const have = SECTOR_UNIVERSE.filter((e) => maps.get(e.id)!.has(d)).length;
    if (have >= NEEDED) keep.push(i);
  }
  if (keep.length === 0) return { ...emptyOpportunity(), missingSymbols };

  const axis = keep.map((i) => dates[i]!);
  const sectorCloses = {} as Record<SectorClockId, (number | null)[]>;
  for (const etf of SECTOR_UNIVERSE) {
    const m = maps.get(etf.id)!;
    sectorCloses[etf.id] = axis.map((d) => m.get(d) ?? null);
  }
  const benchmarkCloses = keep.map((i) => spyClose[i] ?? null);
  const series = computeSectorClockSeries({ sectorCloses, benchmarkCloses });
  const last = series.at(-1);
  const prev = series.at(-2) ?? null;
  if (!last) return { ...emptyOpportunity(), missingSymbols };

  const sectors = clockOf(last, prev);
  return {
    asOf: axis.at(-1) ?? null,
    missingSymbols,
    sectors,
    leaders: last.top3,
    bottoming: last.bottoming,
    pool: [],
    candidates: [],
  };
}
