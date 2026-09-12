import { clockOf } from "@/lib/opportunity/clockOf";
import { computeSectorClockSeries, type SectorClockInput } from "@/lib/scoring/sectorClock";
import { type SectorClockId, SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";
import { describe, expect, it } from "vitest";

const IDS = SECTOR_UNIVERSE.map((s) => s.id);
const N = 200;

const ramp = (dailyPct: number, len = N) =>
  Array.from({ length: len }, (_, i) => 100 * (1 + dailyPct / 100) ** i);

function makeInput(overrides: Partial<Record<SectorClockId, number[]>>): SectorClockInput {
  const sectorCloses = {} as Record<SectorClockId, (number | null)[]>;
  for (const id of IDS) sectorCloses[id] = overrides[id] ?? new Array(N).fill(100);
  return { sectorCloses, benchmarkCloses: new Array(N).fill(100) };
}

describe("clockOf", () => {
  it("输出 11 档，id 与 SECTOR_UNIVERSE 一致", () => {
    const day = computeSectorClockSeries(makeInput({})).at(-1)!;
    const rows = clockOf(day);
    expect(rows).toHaveLength(11);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(IDS));
  });

  it("走平时 sls 约为 1", () => {
    const day = computeSectorClockSeries(makeInput({})).at(-1)!;
    for (const row of clockOf(day)) expect(row.sls).toBeCloseTo(1, 8);
  });

  it("单边上涨的科技进入领涨", () => {
    const day = computeSectorClockSeries(makeInput({ TECH: ramp(0.3) })).at(-1)!;
    const tech = clockOf(day).find((r) => r.id === "TECH")!;
    expect(tech.status).toBe("leader");
    expect(tech.rank).toBeLessThanOrEqual(3);
    expect(tech.rps).toBeGreaterThan(50);
  });
});
