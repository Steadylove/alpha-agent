import type { OpportunitySectorRow, OpportunityStock } from "@/lib/opportunity/types";

export type StockGroup = {
  key: string;
  title: string;
  rows: OpportunityStock[];
};

function byStrength(a: OpportunityStock, b: OpportunityStock): number {
  return (b.rps250 ?? -1) - (a.rps250 ?? -1) || a.symbol.localeCompare(b.symbol);
}

export function flattenStocksBySector(
  stocks: OpportunityStock[],
  sectors: OpportunitySectorRow[],
): OpportunityStock[] {
  return groupStocksBySector(stocks, sectors).flatMap((g) => g.rows);
}

export function matchStock(
  stock: OpportunityStock,
  query: string,
  sectorTitle: string,
): boolean {
  const q = query.trim().toUpperCase();
  if (!q) return true;
  return (
    stock.symbol.toUpperCase().includes(q) ||
    stock.name.toUpperCase().includes(q) ||
    stock.industryLabel.toUpperCase().includes(q) ||
    sectorTitle.toUpperCase().includes(q)
  );
}

export function pageSlice<T>(rows: readonly T[], page: number, size: number): { page: number; pages: number; rows: T[] } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;
  return { page: current, pages, rows: rows.slice(start, start + size) };
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
