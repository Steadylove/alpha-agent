import { describe, expect, it } from "vitest";

import { extractCard } from "@/lib/optionFlow/extract";
import { normalizeExpiry } from "@/lib/optionFlow/expiry";
import { mergeChartLeg, parseChartText } from "@/lib/optionFlow/parseChart";

describe("option flow expiry parsing", () => {
  it("reads the full English expiry from the DELL chart instead of keeping a month-only hint", () => {
    const post = extractCard("$4.1 million into these $DELL $800 strike March calls.");
    const chart = parseChartText("DELL 800 Call $37.9\nExp. March 19, 2027\nVol: 1.1K OI: 150 Prem: $4.1M Underlying: $559.2\nOTM: +43.1%");
    expect(chart?.expiry).toBe("03/19/2027");
    const merged = mergeChartLeg(post.legs[0], chart!);
    expect(normalizeExpiry(merged.expiry, "2026-10-02")).toBe("2027-03-19");
  });

  it("accepts abbreviated and ordinal English dates but does not invent missing date parts", () => {
    expect(parseChartText("DELL 800 Call\nExpiration: Mar. 19th, 2028")?.expiry).toBe("03/19/2028");
    expect(parseChartText("DELL 800 Call\nExp. March")?.expiry).toBeUndefined();
    expect(parseChartText("DELL 800 Call\nExp. February 30, 2027")?.expiry).toBeUndefined();
  });

  it("preserves an explicit year in a month/day expiry from source text", () => {
    const leg = extractCard("$4.1 million into these $DELL $800 strike calls expiring March 19, 2028.").legs[0];
    expect(leg.expiry).toBe("March 19, 2028");
    expect(normalizeExpiry(leg.expiry, "2026-10-02")).toBe("2028-03-19");
  });
});
