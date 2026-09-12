import { buildClockSnapshot } from "@/lib/opportunity/clockSnapshot";
import { describe, expect, it } from "vitest";

function series(start: string, n: number, step = 0.2): { date: string; close: number }[] {
  const out: { date: string; close: number }[] = [];
  let v = 100;
  const day = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < n; i += 1) {
    out.push({ date: day.toISOString().slice(0, 10), close: v });
    v *= 1 + step / 100;
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

const flat = series("2024-01-01", 120, 0);

describe("buildClockSnapshot", () => {
  it("缺 SPY 则只报缺失", () => {
    const data = buildClockSnapshot(new Map());
    expect(data.asOf).toBeNull();
    expect(data.missingSymbols).toContain("SPY");
    expect(data.sectors).toHaveLength(0);
  });

  it("齐备时写出 11 档", () => {
    const bars = new Map<string, { date: string; close: number }[]>();
    bars.set("SPY", flat);
    for (const s of ["XLK", "XLF", "XLV", "XLY", "XLC", "XLI", "XLP", "XLE", "XLRE", "XLU", "XLB"]) {
      bars.set(s, s === "XLK" ? series("2024-01-01", 120, 0.4) : flat);
    }
    const data = buildClockSnapshot(bars);
    expect(data.sectors).toHaveLength(11);
    expect(data.asOf).toBe("2024-04-29");
    expect(data.sectors.find((r) => r.id === "TECH")?.status).toBe("leader");
  });
});
