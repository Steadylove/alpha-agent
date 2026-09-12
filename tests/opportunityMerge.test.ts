import { buildClockSnapshot } from "@/lib/opportunity/clockSnapshot";
import { mergeScreener } from "@/lib/opportunity/mergeScreener";
import { describe, expect, it } from "vitest";

function series(n: number, step = 0): { date: string; close: number }[] {
  const out: { date: string; close: number }[] = [];
  let v = 100;
  const day = new Date("2024-01-01T00:00:00Z");
  for (let i = 0; i < n; i += 1) {
    out.push({ date: day.toISOString().slice(0, 10), close: v });
    v *= 1 + step / 100;
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

function clock() {
  const bars = new Map<string, { date: string; close: number }[]>();
  const flat = series(120);
  bars.set("SPY", flat);
  for (const s of ["XLK", "XLF", "XLV", "XLY", "XLC", "XLI", "XLP", "XLE", "XLRE", "XLU", "XLB"]) {
    bars.set(s, s === "XLK" ? series(120, 0.4) : flat);
  }
  return buildClockSnapshot(bars);
}

describe("mergeScreener", () => {
  it("无截面时仍保留时钟，并对照现网池", () => {
    const data = mergeScreener(clock(), null, ["RKLB"]);
    expect(data.sectors).toHaveLength(11);
    expect(data.candidates).toHaveLength(0);
    expect(data.pool).toMatchObject([{ symbol: "RKLB", sectorId: "INDU" }]);
  });

  it("有截面时写入广度和候选", () => {
    const data = mergeScreener(
      clock(),
      [
        {
          symbol: "NVDA",
          sector: "Information Technology",
          industry: "Semiconductors",
          rps: { 20: 90, 50: 88, 120: 86, 250: 91 },
          prevRps250: 70,
          elite: true,
        },
      ],
      ["NVDA"],
    );
    expect(data.sectors.find((r) => r.id === "TECH")?.breadth).toEqual({
      sample: 1,
      strong: 1,
      rising: 1,
    });
    expect(data.candidates).toHaveLength(1);
    expect(data.pool[0]?.inLivePool).toBe(true);
  });
});
