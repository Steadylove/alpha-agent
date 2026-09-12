import { candidatesOf, overlayPool, universeOf } from "@/lib/opportunity/poolOverlay";
import { describe, expect, it } from "vitest";

describe("overlayPool", () => {
  it("标普票走截面行业，非标普走 extra，未知为未分类", () => {
    const ranked = [
      {
        symbol: "NVDA",
        name: "NVIDIA",
        sector: "Information Technology",
        industry: "Semiconductors",
        rps: { 20: 90, 50: 88, 120: 85, 250: 92 },
        prevRps250: 80,
        elite: true,
      },
    ];
    const rows = overlayPool(["NVDA", "RKLB", "ZZZZ"], ranked);
    expect(rows.find((r) => r.symbol === "NVDA")).toMatchObject({
      sectorId: "TECH",
      rps250: 92,
      rpsDelta: 12,
      inLivePool: true,
    });
    expect(rows.find((r) => r.symbol === "RKLB")?.sectorId).toBe("INDU");
    expect(rows.find((r) => r.symbol === "ZZZZ")).toMatchObject({
      sectorId: null,
      industryLabel: "未分类",
      rps250: null,
    });
  });

  it("现网池里不在标普的票走 extra", () => {
    const rows = overlayPool(["TSM", "CCEP", "MP", "BE", "ALAB"], []);
    expect(rows.find((r) => r.symbol === "TSM")).toMatchObject({
      sectorId: "TECH",
      industryLabel: "信息技术｜半导体",
    });
    expect(rows.find((r) => r.symbol === "CCEP")?.sectorId).toBe("STAPLES");
    expect(rows.find((r) => r.symbol === "MP")?.sectorId).toBe("MATERIAL");
    expect(rows.find((r) => r.symbol === "BE")?.sectorId).toBe("INDU");
    expect(rows.find((r) => r.symbol === "ALAB")?.sectorId).toBe("TECH");
  });
});

describe("candidatesOf", () => {
  it("只收精英或新高，并标是否在现网池", () => {
    const ranked = [
      {
        symbol: "A",
        sector: "Energy",
        industry: null,
        rps: { 20: 81, 50: 82, 120: 83, 250: 84 },
        elite: true,
      },
      {
        symbol: "B",
        sector: "Energy",
        industry: null,
        rps: { 20: 10, 50: 10, 120: 10, 250: 10 },
      },
    ];
    const rows = candidatesOf(ranked, new Set(["A"]));
    expect(rows.map((r) => r.symbol)).toEqual(["A"]);
    expect(rows[0]).toMatchObject({ sectorId: "ENERGY", inLivePool: true, elite: true });
  });
});

describe("universeOf", () => {
  it("收下全截面，并把池里不在截面的票补进去", () => {
    const ranked = [
      {
        symbol: "A",
        sector: "Energy",
        industry: null,
        rps: { 20: 10, 50: 10, 120: 10, 250: 10 },
      },
    ];
    const rows = universeOf(ranked, new Set(["A", "RKLB"]));
    expect(rows.map((r) => r.symbol)).toEqual(["A", "RKLB"]);
    expect(rows.find((r) => r.symbol === "RKLB")?.inLivePool).toBe(true);
  });
});
