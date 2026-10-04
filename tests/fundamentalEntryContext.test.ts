import { describe, expect, it } from "vitest";
import { fundamentalBookEntryAt, fundamentalEntryAt, fundamentalSignalEntryAt, fundamentalUrl } from "@/components/fundamental/entryContext";

const now = Date.parse("2026-10-04T12:00:00Z");
describe("fundamental entry provenance", () => {
  it("normalizes only known UTC model clocks, never local timezone or a calendar day", () => {
    expect(fundamentalBookEntryAt("2026-09-25T13:30", now)).toBe("2026-09-25T13:30:00.000Z");
    expect(fundamentalBookEntryAt("2026-01-23T14:30", now)).toBe("2026-01-23T14:30:00.000Z");
    expect(fundamentalEntryAt("2026-09-25T13:30", now)).toBeNull();
    expect(fundamentalBookEntryAt("2026-09-25", now)).toBeNull();
  });
  it("preserves actual signal instants across DST and offset notations", () => {
    expect(fundamentalEntryAt("2026-09-25T09:30:00-04:00", now)).toBe("2026-09-25T13:30:00.000Z");
    expect(fundamentalEntryAt("2026-01-23T09:30:00-05:00", now)).toBe("2026-01-23T14:30:00.000Z");
    expect(fundamentalSignalEntryAt(Date.parse("2026-09-25T17:30:00Z"), now)).toBe("2026-09-25T17:30:00.000Z");
  });
  it("rejects missing, impossible and future instants rather than inventing entry knowledge", () => {
    for (const invalid of [null, undefined, "", "2026-02-30T13:30", "2026-01-10T25:00", "2026-10-05T13:30", "bad"])
      expect(fundamentalBookEntryAt(invalid, now)).toBeNull();
    for (const invalid of [NaN, Infinity, 0, -1, now + 1]) expect(fundamentalSignalEntryAt(invalid, now)).toBeNull();
  });
  it("keeps the exact context on API and page links without mixing two timeframes", () => {
    const earlier = "2026-09-24T13:30:00Z", later = "2026-09-25T15:30:00Z";
    const a = new URL(fundamentalUrl("BRK.B", earlier), "http://localhost");
    const b = new URL(fundamentalUrl("BRK.B", later, true), "http://localhost");
    expect(a.pathname).toBe("/fundamental/BRK.B"); expect(b.pathname).toBe("/api/fundamental/BRK.B");
    expect(a.searchParams.get("entryAt")).toBe("2026-09-24T13:30:00.000Z");
    expect(b.searchParams.get("entryAt")).toBe("2026-09-25T15:30:00.000Z");
    expect(fundamentalUrl("ACME", "2026-09-25")).toBe("/fundamental/ACME");
  });
});
