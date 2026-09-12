import type { OpportunitySectorRow, OpportunityStock } from "@/lib/opportunity/types";

export type StockGroup = {
  key: string;
  title: string;
  rows: OpportunityStock[];
};

function byStrength(a: OpportunityStock, b: OpportunityStock): number {
  return (b.rps250 ?? -1) - (a.rps250 ?? -1) || a.symbol.localeCompare(b.symbol);
}

/** 按时钟表顺序分行业，未分类垫底。空档不出现。 */
export function groupStocksBySector(
  stocks: OpportunityStock[],
  sectors: OpportunitySectorRow[],
): StockGroup[] {
  return [
    ...sectors.map((sec) => ({
      key: sec.id,
      title: sec.name,
      rows: stocks.filter((s) => s.sectorId === sec.id).sort(byStrength),
    })),
    {
      key: "none",
      title: "未分类",
      rows: stocks.filter((s) => s.sectorId == null).sort(byStrength),
    },
  ].filter((g) => g.rows.length > 0);
}
