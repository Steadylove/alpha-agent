import type { Instrument } from "@/lib/types/market";

/** 现网池里常见、但不在标普 GICS 表里的票。行业名走公开 GICS 口径。 */
export const EXTRA_SECTORS: Record<string, { sector: string; industry: string }> = {
  RKLB: { sector: "Industrials", industry: "Aerospace & Defense" },
  IONQ: { sector: "Information Technology", industry: "Technology Hardware, Storage & Peripherals" },
  IREN: { sector: "Information Technology", industry: "Application Software" },
  NBIS: { sector: "Information Technology", industry: "Internet Services & Infrastructure" },
  ASTS: { sector: "Communication Services", industry: "Alternative Carriers" },
  HUT: { sector: "Information Technology", industry: "Application Software" },
  CRWV: { sector: "Information Technology", industry: "Internet Services & Infrastructure" },
  OKLO: { sector: "Utilities", industry: "Independent Power Producers & Energy Traders" },
  ONDS: { sector: "Information Technology", industry: "Communications Equipment" },
  RCAT: { sector: "Industrials", industry: "Aerospace & Defense" },
  SERV: { sector: "Industrials", industry: "Diversified Support Services" },
  POET: { sector: "Information Technology", industry: "Semiconductors" },
  PL: { sector: "Industrials", industry: "Aerospace & Defense" },
  AAOI: { sector: "Information Technology", industry: "Communications Equipment" },
  SNDK: { sector: "Information Technology", industry: "Technology Hardware, Storage & Peripherals" },
  ALAB: { sector: "Information Technology", industry: "Semiconductors" },
  ARM: { sector: "Information Technology", industry: "Semiconductors" },
  ASML: { sector: "Information Technology", industry: "Semiconductor Materials & Equipment" },
  BE: { sector: "Industrials", industry: "Electrical Components & Equipment" },
  CCEP: { sector: "Consumer Staples", industry: "Soft Drinks & Non-alcoholic Beverages" },
  CRDO: { sector: "Information Technology", industry: "Semiconductors" },
  MP: { sector: "Materials", industry: "Diversified Metals & Mining" },
  POWL: { sector: "Industrials", industry: "Electrical Components & Equipment" },
  TSM: { sector: "Information Technology", industry: "Semiconductors" },
};

function extraInstrument(symbol: string): Instrument {
  const extra = EXTRA_SECTORS[symbol];
  return {
    symbol,
    name: symbol,
    type: "STOCK",
    ...(extra ? { sector: extra.sector, industry: extra.industry } : {}),
  };
}

/** 筛选宇宙 = 标普 + 现网池里不在标普的票。 */
export function withPoolExtras(base: readonly Instrument[], extras: readonly string[]): Instrument[] {
  const have = new Set(base.map((u) => u.symbol));
  return [...base, ...extras.filter((s) => !have.has(s)).map(extraInstrument)];
}
