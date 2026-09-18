import type { PanelBars } from "@/lib/backtest/panel";
import { SECTOR_UNIVERSE, type SectorClockId } from "@/lib/scoring/sectorUniverse";

export type SectorMember = { symbol: string; sector?: string };
export type SectorRow = { id: SectorClockId; name: string; etf: string; relative20: number | null; percentile: number | null;
  above50: number; valid: number; total: number; breadth: number | null; points: number | null };
export type SectorSnapshot = { version: 1; asOf: string; generatedAt: string; membershipAsOf: string; membershipSource: string;
  classification: Record<string, SectorClockId>; classificationEvidence?: Record<string, { asOf: string; source: string }>; sectors: SectorRow[] };
export type SectorFactor = { points: number | null; reason: string; row?: SectorRow; asOf?: string; membershipAsOf?: string; membershipSource?: string;
  classificationEvidence?: { asOf: string; source: string } };
const mappings: Record<string, SectorClockId> = {
  "information technology": "TECH", technology: "TECH", financials: "FIN", "financial services": "FIN",
  "health care": "HEALTH", healthcare: "HEALTH", "consumer discretionary": "DISC", "consumer cyclical": "DISC",
  "communication services": "COMM", industrials: "INDU", "consumer staples": "STAPLES", "consumer defensive": "STAPLES",
  energy: "ENERGY", utilities: "UTIL", "real estate": "REIT", materials: "MATERIAL", "basic materials": "MATERIAL",
};
/** 未知归属保持缺失，绝不默认归入科技。 */
export const strictSectorId = (sector?: string) => sector ? mappings[sector.trim().toLowerCase()] : undefined;

/** 只读 asOf 及之前日线；广度仅代表标普成分股，不代表全行业。 */
export function buildSectorSnapshot(panels: readonly PanelBars[], members: readonly SectorMember[], asOf: string,
  provenance: Pick<SectorSnapshot, "generatedAt" | "membershipAsOf" | "membershipSource">): SectorSnapshot {
  const byTicker = new Map(panels.map(p => [p.ticker, p]));
  const spy = byTicker.get("SPY"), days = spy?.dates.filter(d => d <= asOf).slice(-50) ?? [];
  const validAxis = days.length === 50 && days.at(-1) === asOf;
  const closes = (ticker: string, n: number): number[] | null => {
    if (!validAxis) return null;
    const p = byTicker.get(ticker); if (!p) return null;
    const xs = days.slice(-n).map(d => p.close[p.dates.indexOf(d)]);
    return xs.every(x => Number.isFinite(x) && x > 0) ? xs : null;
  };
  const benchmark = closes("SPY", 21);
  const classification: SectorSnapshot["classification"] = {};
  for (const member of members) { const id = strictSectorId(member.sector); if (id) classification[member.symbol] = id; }
  const rows: SectorRow[] = SECTOR_UNIVERSE.map(sector => {
    const etf = closes(sector.symbol, 21);
    const relative20 = etf && benchmark ? etf.at(-1)! / etf[0] - benchmark.at(-1)! / benchmark[0] : null;
    const symbols = Object.keys(classification).filter(ticker => classification[ticker] === sector.id);
    let valid = 0, above50 = 0;
    for (const symbol of symbols) {
      const xs = closes(symbol, 50); if (!xs) continue;
      valid++; if (xs.at(-1)! > xs.reduce((a, b) => a + b, 0) / 50) above50++;
    }
    const breadth = valid >= 10 && valid / symbols.length >= .95 ? above50 / valid : null;
    return { id: sector.id, name: sector.name, etf: sector.symbol, relative20, percentile: null, above50, valid, total: symbols.length, breadth, points: null };
  });
  if (rows.every(r => r.relative20 != null)) for (const row of rows) {
    const lower = rows.filter(r => r.relative20! < row.relative20!).length;
    const tied = rows.filter(r => r.relative20 === row.relative20).length;
    row.percentile = (lower + (tied - 1) / 2) / (rows.length - 1);
    // 初始等权映射，非拟合最优值；原始数据保留以供后续消融与样本外验证。
    if (row.breadth != null) row.points = Math.round(15 * (row.percentile + row.breadth) / 2 * 10) / 10;
  }
  return { version: 1, asOf, ...provenance, classification, sectors: rows };
}

/** 线上要求快照/分类在信号前已知；历史重算单独显式放行，并在产物中标注。 */
export function sectorFactorOf(snapshot: SectorSnapshot | undefined, symbol: string, expectedDay: string | undefined,
  signalTime: number | undefined, replay = false): SectorFactor {
  const missing = (reason: string): SectorFactor => ({ points: null, reason });
  if (!snapshot || !expectedDay || snapshot.asOf !== expectedDay) return missing("缺少对应前一交易日板块数据");
  const generated = Date.parse(snapshot.generatedAt);
  const signalDay = Number.isFinite(signalTime) ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(signalTime) : "";
  if (!signalDay || snapshot.asOf >= signalDay || !Number.isFinite(generated) || (!replay && (generated > signalTime! + 60_000 || snapshot.membershipAsOf > signalDay))) return missing("板块快照或分类晚于信号，不能用于当时评分");
  const ticker = symbol.slice(symbol.lastIndexOf(":") + 1).trim().toUpperCase();
  const id = snapshot.classification[ticker], row = snapshot.sectors.find(r => r.id === id);
  if (!row) return missing("没有可核验的板块归属");
  const classificationEvidence = snapshot.classificationEvidence?.[ticker];
  if (!replay && classificationEvidence && classificationEvidence.asOf > signalDay) return missing("板块归属在信号之后才核验");
  return { points: row.points, row, asOf: snapshot.asOf, membershipAsOf: snapshot.membershipAsOf, membershipSource: snapshot.membershipSource,
    classificationEvidence,
    reason: row.points == null ? `${row.name}数据不足；广度样本 ${row.valid}/${row.total}` :
      `${row.name} · 20日相对SPY ${(row.relative20! * 100).toFixed(2)}个百分点 · 标普板块广度 ${(row.breadth! * 100).toFixed(1)}%（${row.valid}/${row.total}）` };
}
