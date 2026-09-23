import { SECTOR_UNIVERSE, mapSectorToClock } from "@/lib/scoring/sectorUniverse";
import { EXTRA_SECTORS } from "@/lib/opportunity/extraSectors";
import type { SectorSnapshot } from "@/lib/signals/sectorFactor";

export const THEME_VERSION = "2026-09-v1";
const groups: [string, string[]][] = [
  ["半导体 / 算力", ["NVDA", "AMD", "INTC", "MU", "AVGO", "QCOM", "AAOI", "AXTI", "ALAB", "TSM", "ARM", "MRVL", "SMCI", "DELL", "LRCX", "AMAT", "KLAC", "ASML", "SMH", "SOXX"]],
  ["加密资产", ["HUT", "MARA", "RIOT", "IREN", "CIFR", "CLSK", "COIN", "MSTR", "IBIT", "FBTC", "BITO", "ETHA"]],
  ["软件 / 云服务", ["MSFT", "ORCL", "PLTR", "DDOG", "CRM", "SNOW", "CRWD", "NET", "NOW", "ADBE", "IGV", "CRWV", "NBIS"]],
  ["指数 / 杠杆指数", ["SPY", "SPX", "QQQ", "IWM", "DIA", "RSP", "TQQQ", "SQQQ", "SPXL", "SPXS", "VTI", "VOO"]],
];
const etfs = new Set(["SPY", "SPX", "QQQ", "IWM", "DIA", "RSP", "TQQQ", "SQQQ", "SPXL", "SPXS", "VTI", "VOO", "IBIT", "FBTC", "BITO", "ETHA", "IGV", "SMH", "SOXX", "ARKK", "TLT", "GLD", "SLV", "HYG", "XBI", "SPCX", ...SECTOR_UNIVERSE.map(s => s.symbol)]);
export function flowTheme(ticker: string, sector?: SectorSnapshot) {
  const id = sector?.classification[ticker] ?? (EXTRA_SECTORS[ticker] ? mapSectorToClock(EXTRA_SECTORS[ticker].sector) : undefined);
  const sectorName = SECTOR_UNIVERSE.find(s => s.id === id)?.name ?? "未分类";
  return { asset: etfs.has(ticker) ? "ETF / 指数" as const : "个股" as const,
    sector: etfs.has(ticker) ? "ETF / 指数" : sectorName,
    // Exclusive primary themes keep reported premium additive.
    theme: groups.find(([, members]) => members.includes(ticker))?.[0] ?? (sectorName !== "未分类" ? sectorName : "其他 / 待分类") };
}
