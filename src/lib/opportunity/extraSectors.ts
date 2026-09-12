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
};
