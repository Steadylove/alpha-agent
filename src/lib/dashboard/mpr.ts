import { hasDatabase } from "@/lib/db/remote";
import { MPR_SYMBOLS } from "@/lib/scoring/mpr";

/** MacroPhaseState 落库的字段子集，页面只需要这些。 */
export type MacroPhaseSnapshot = {
  date: string;
  pathId: number;
  fsmState: number;
  marketRiskScore: number;
  prob5dDown: number;
  f1: number;
  f2: number;
  f3: number;
  f4: number;
  f5: number;
  rawTerm: number;
  rawCred: number;
  domVol: number;
  domCred: number;
  domSpot: number;
  spyDamage: number;
  leadGap: number;
  leadPersist: number;
  leadQuality: number;
  transVel: number;
  /** 传导深度 0~3，路径判定的中间量 */
  transDepth: number;
  couplingRatio: number;
  /** 三域 σ 分级：0 平静 / 1 异动 / 2 极端 */
  sigmaVol: number;
  sigmaCred: number;
  sigmaSpot: number;
};

/** 时间轴用的一天：MPR 快照加上当日 SPY 收盘，便于看路径判定是否滞后于价格。 */
export type MprHistoryPoint = MacroPhaseSnapshot & { spyClose: number | null };

export type MprData = {
  latest: MacroPhaseSnapshot | null;
  /** 近端历史，最新的在最后。 */
  history: MprHistoryPoint[];
  /** 宏观日线缺失的标的，非空时说明还没跑 npm run backfill:macro。 */
  missingSymbols: string[];
};

/** 时间轴展示长度，需不超过 macroPhase 任务的回写窗口。 */
const HISTORY_DAYS = 120;

/**
 * 读取 macro-phase 任务落库的 MPR 快照。
 *
 * 页面不做实时计算：全历史日线要拉 4.5 万行、页面会掉到 2s 级，
 * 而读快照表只是一次索引扫描。表为空时返回空数据由前端提示去跑任务。
 */
export async function getMprData(): Promise<MprData> {
  if (!hasDatabase()) {
    return { latest: null, history: [], missingSymbols: [...MPR_SYMBOLS] };
  }

  const { getPrisma } = await import("@/lib/db/prisma");
  const prisma = getPrisma();

  const rows = await prisma.macroPhaseState.findMany({
    orderBy: { date: "desc" },
    take: HISTORY_DAYS,
  });

  if (rows.length === 0) {
    const instruments = await prisma.instrument.findMany({
      where: { symbol: { in: [...MPR_SYMBOLS] } },
      select: { symbol: true },
    });
    const found = new Set(instruments.map((i) => i.symbol));
    return { latest: null, history: [], missingSymbols: MPR_SYMBOLS.filter((s) => !found.has(s)) };
  }

  // 路径色带单看是孤立的，叠上 SPY 才能判断它领先还是滞后于价格。
  const spyBars = await prisma.dailyBar.findMany({
    where: {
      instrument: { symbol: "SPY" },
      date: { gte: rows[rows.length - 1].date, lte: rows[0].date },
    },
    select: { date: true, close: true },
  });
  const spyByDate = new Map(spyBars.map((b) => [b.date.toISOString().slice(0, 10), b.close]));

  const history = rows
    .map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      spyClose: spyByDate.get(row.date.toISOString().slice(0, 10)) ?? null,
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
    }))
    .reverse();

  return { latest: history.at(-1) ?? null, history, missingSymbols: [] };
}
