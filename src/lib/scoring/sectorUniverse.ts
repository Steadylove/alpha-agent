/**
 * SLS 3.0 行业生命周期时钟的 11 只 SPDR 行业 ETF。
 *
 * 逐条对应「MarketCompass」Pine 第 159~169 行的 request.security 调用，
 * 顺序也与 Pine 里 sec_names / sec_scores 数组的下标一致。
 */

export type SectorClockId =
  | "TECH"
  | "FIN"
  | "HEALTH"
  | "DISC"
  | "COMM"
  | "INDU"
  | "STAPLES"
  | "ENERGY"
  | "REIT"
  | "UTIL"
  | "MATERIAL";

export type SectorEtf = {
  id: SectorClockId;
  symbol: string;
  /** Pine 第 198~200 行的中文名 */
  name: string;
  /** ETF 成立日，早于此日期的 SLS 排名缺这一档 */
  inception: string;
};

export const SECTOR_UNIVERSE: readonly SectorEtf[] = [
  { id: "TECH", symbol: "XLK", name: "信息科技", inception: "1998-12-22" },
  { id: "FIN", symbol: "XLF", name: "金融", inception: "1998-12-22" },
  { id: "HEALTH", symbol: "XLV", name: "医疗健康", inception: "1998-12-22" },
  { id: "DISC", symbol: "XLY", name: "可选消费", inception: "1998-12-22" },
  { id: "COMM", symbol: "XLC", name: "通信服务", inception: "2018-06-18" },
  { id: "INDU", symbol: "XLI", name: "工业", inception: "1998-12-22" },
  { id: "STAPLES", symbol: "XLP", name: "日常消费", inception: "1998-12-22" },
  { id: "ENERGY", symbol: "XLE", name: "能源", inception: "1998-12-22" },
  { id: "REIT", symbol: "XLRE", name: "房地产", inception: "2015-10-08" },
  { id: "UTIL", symbol: "XLU", name: "公用事业", inception: "1998-12-22" },
  { id: "MATERIAL", symbol: "XLB", name: "原材料", inception: "1998-12-22" },
];

/**
 * 把数据源给出的行业名映射到 11 档时钟。
 *
 * 忠实复刻 Pine 第 248~271 行的 `str.contains` 链，包括判定顺序——
 * 顺序有实际影响，例如「Consumer Defensive」既含 Defensive 也不含 Cyclical，
 * 必须让可选消费那一档先走。
 *
 * Pine 的兜底是「未匹配一律算信息科技」，这里保留该行为；调用方若拿到的是
 * ETF 这类本就没有行业归属的标的，应在外层跳过而不是依赖兜底。
 */
export function mapSectorToClock(rawSector: string | null | undefined): SectorClockId {
  const s = rawSector ?? "";
  const has = (...needles: string[]) => needles.some((n) => s.includes(n));

  if (has("Tech", "Electronic", "Software", "Hardware", "Semiconductor")) return "TECH";
  if (has("Financial", "Bank", "Insurance")) return "FIN";
  if (has("Health", "Pharma", "Bio", "Medical")) return "HEALTH";
  if (has("Consumer Cyclical", "Discretionary", "Retail")) return "DISC";
  if (has("Communication", "Media", "Telecom")) return "COMM";
  if (has("Industrial", "Capital Goods", "Transportation", "Aerospace")) return "INDU";
  if (has("Defensive", "Staples")) return "STAPLES";
  if (has("Energy", "Oil", "Gas")) return "ENERGY";
  if (has("Real Estate", "REIT")) return "REIT";
  if (has("Utilities", "Power")) return "UTIL";
  if (has("Material", "Chemical", "Mining")) return "MATERIAL";
  return "TECH";
}
