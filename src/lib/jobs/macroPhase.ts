import type { MprData, MprHistoryPoint } from "@/lib/dashboard/mpr";
import {
  MPR_SYMBOLS,
  alignMprInputs,
  computeMprSeries,
  type AlignBar,
  type MprSymbol,
} from "@/lib/scoring/mpr";
import { loadDailyBars } from "@/lib/vps/loadDailyBars";
import { writeSnapshot } from "@/lib/vps/snapshot";

/**
 * 每日重算 MPR，写入 VPS snapshots/mpr.json。
 *
 * 全序列重算而非只算最新一天:MPR 有 252 日 ECDF 预热和跨日状态递推,
 * 必须从序列起点连续算。
 */

const HISTORY_DAYS = 120;

export type MacroPhaseJobResult = {
  latestDate: string | null;
  pathId: number | null;
  marketRiskScore: number | null;
  pathChanged: boolean;
  previousPathId: number | null;
  seriesLength: number;
  recordsWritten: number;
};

async function loadBars(): Promise<{ bySymbol: Record<MprSymbol, AlignBar[]>; missing: string[] }> {
  const loaded = await loadDailyBars(MPR_SYMBOLS);
  const missing = MPR_SYMBOLS.filter((s) => !loaded.has(s) || (loaded.get(s)?.length ?? 0) === 0);
  const bySymbol = {} as Record<MprSymbol, AlignBar[]>;
  for (const symbol of MPR_SYMBOLS) {
    const rows = loaded.get(symbol) ?? [];
    bySymbol[symbol] = rows.map((b) => ({ date: b.date, close: b.close, volume: b.volume }));
  }
  return { bySymbol, missing };
}

export async function runMacroPhaseJob(): Promise<MacroPhaseJobResult> {
  const { bySymbol, missing } = await loadBars();
  if (missing.length > 0) {
    throw new Error(`缺少宏观标的 ${missing.join(", ")}，先把这些票的日线 CSV 写到 VPS`);
  }

  const rows = alignMprInputs(bySymbol);
  const series = computeMprSeries(rows);
  if (series.length === 0) {
    throw new Error("对齐后无可用交易日");
  }

  const spyByDate = new Map(bySymbol.SPY.map((b) => [b.date, b.close]));
  const window = series.slice(-HISTORY_DAYS);
  const history: MprHistoryPoint[] = window.map((row) => ({
    date: row.date,
    spyClose: spyByDate.get(row.date) ?? null,
    pathId: row.pathId,
    fsmState: row.fsmState,
    marketRiskScore: row.marketRiskScore,
    prob5dDown: row.prob5dDown,
    f1: row.f1,
    f2: row.f2,
    f3: row.f3,
    f4: row.f4,
    f5: row.f5,
    rawTerm: row.rawTerm,
    rawCred: row.rawCred,
    domVol: row.domVol,
    domCred: row.domCred,
    domSpot: row.domSpot,
    spyDamage: row.spyDamage,
    leadGap: row.leadGap,
    leadPersist: row.leadPersist,
    leadQuality: row.leadQuality,
    transVel: row.transVel,
    transDepth: row.transDepth,
    couplingRatio: row.couplingRatio,
    sigmaVol: row.sigmaVol,
    sigmaCred: row.sigmaCred,
    sigmaSpot: row.sigmaSpot,
  }));

  const snapshot: MprData = {
    latest: history.at(-1) ?? null,
    history,
    missingSymbols: [],
  };
  writeSnapshot("mpr", snapshot);

  const latest = series.at(-1)!;
  const previous = series.at(-2) ?? null;
  return {
    latestDate: latest.date,
    pathId: latest.pathId,
    marketRiskScore: latest.marketRiskScore,
    pathChanged: previous != null && previous.pathId !== latest.pathId,
    previousPathId: previous?.pathId ?? null,
    seriesLength: series.length,
    recordsWritten: history.length,
  };
}
