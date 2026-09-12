import { groupStocksBySector } from "@/lib/opportunity/groupStocks";
import type { OpportunitySectorRow, OpportunityStock } from "@/lib/opportunity/types";
import { describe, expect, it } from "vitest";

function sector(id: OpportunitySectorRow["id"], name: string): OpportunitySectorRow {
  return {
    id,
    symbol: "XLK",
    name,
    rank: 1,
    status: "neutral",
    sls: 0,
    mom21: 0,
    rps: 0,
    rpsDelta: null,
    breadth: null,
  };
}

function stock(partial: Partial<OpportunityStock> & Pick<OpportunityStock, "symbol">): OpportunityStock {
  return {
    name: "",
    sectorId: null,
    industryLabel: "",
    rps20: null,
    rps50: null,
    rps120: null,
    rps250: null,
    rpsDelta: null,
    inLivePool: false,
    elite: false,
    newHigh: false,
    ...partial,
  };
}

describe("groupStocksBySector", () => {
  it("按时钟顺序分档，档内按 RPS250 降序，空档省略", () => {
    const groups = groupStocksBySector(
      [
        stock({ symbol: "AAPL", sectorId: "TECH", rps250: 70 }),
        stock({ symbol: "NVDA", sectorId: "TECH", rps250: 95 }),
        stock({ symbol: "XOM", sectorId: "ENERGY", rps250: 88 }),
        stock({ symbol: "ZZZZ" }),
      ],
      [sector("TECH", "信息科技"), sector("ENERGY", "能源"), sector("FIN", "金融")],
    );

    expect(groups.map((g) => [g.key, g.rows.map((r) => r.symbol)])).toEqual([
      ["TECH", ["NVDA", "AAPL"]],
      ["ENERGY", ["XOM"]],
      ["none", ["ZZZZ"]],
    ]);
  });
});
