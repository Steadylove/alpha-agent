import { withPoolExtras } from "@/lib/opportunity/extraSectors";
import type { Instrument } from "@/lib/types/market";
import { describe, expect, it } from "vitest";

const nvda: Instrument = {
  symbol: "NVDA",
  name: "NVIDIA",
  type: "STOCK",
  sector: "Technology",
};

describe("withPoolExtras", () => {
  it("标普已有的不重复，池外票补进去，对不上 extra 的也进宇宙", () => {
    const rows = withPoolExtras([nvda], ["NVDA", "TSM", "ZZZZ"]);
    expect(rows.map((r) => r.symbol)).toEqual(["NVDA", "TSM", "ZZZZ"]);
    expect(rows.find((r) => r.symbol === "TSM")).toMatchObject({
      sector: "Information Technology",
      industry: "Semiconductors",
    });
    expect(rows.find((r) => r.symbol === "ZZZZ")).toMatchObject({
      symbol: "ZZZZ",
      type: "STOCK",
    });
    expect(rows.find((r) => r.symbol === "ZZZZ")?.sector).toBeUndefined();
  });
});
