import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";

/** RotationState 落库的字段子集。 */
export type RotationHolding = {
  symbol: string;
  close: number;
  rs: number;
  sigType: number;
  entryPrice: number | null;
  effectiveStop: number | null;
  floatPnlPct: number;
  maxPnlPct: number;
  breakevenLocked: boolean;
  /** RS 动态加权后的仓位占比（%），空仓为 0。 */
  weightPct: number;
  /** 对组合净值的拉动 = 个股浮盈 × 仓位占比。 */
  navContribPct: number;
};

export type RecentSignal = {
  date: string;
  symbol: string;
  sigType: number;
  rs: number;
  close: number;
};

export type RotationStats = {
  /** 今年已平仓交易的累计收益（单票口径求和）。 */
  closedPnlSum: number;
  /** 按历史平均满仓标的数摊薄后的组合口径已落袋收益。 */
  closedNavPct: number;
  /** 当前满仓 RS 加权浮盈。 */
  openNavPct: number;
  totalNavPct: number;
  trades: number;
  wins: number;
  winRatePct: number;
};

export type RotationData = {
  latestDate: string | null;
  holdings: RotationHolding[];
  /** 全部 40 只的最新状态，含空仓。 */
  all: RotationHolding[];
  recentSignals: RecentSignal[];
  stats: RotationStats;
  universeSize: number;
  /** 样本不足被跳过的标的。 */
  skippedSymbols: string[];
};

/** 与 Pine 的 avg_slots 一致：把单票收益摊薄到组合口径的除数。 */
const AVG_SLOTS = 8;
const RECENT_SIGNAL_DAYS = 30;

const EMPTY_STATS: RotationStats = {
  closedPnlSum: 0,
  closedNavPct: 0,
  openNavPct: 0,
  totalNavPct: 0,
  trades: 0,
  wins: 0,
  winRatePct: 0,
};

/**
 * 读取 rotation-radar 任务落库的轮动快照。
 *
 * 与 MPR 页面同理，页面不做实时计算：40 只标的的全历史要拉 13 万行日线。
 */
export async function getRotationData(): Promise<RotationData> {
  const universeSize = ROTATION_UNIVERSE.length;
  const empty: RotationData = {
    latestDate: null,
    holdings: [],
    all: [],
    recentSignals: [],
    stats: EMPTY_STATS,
    universeSize,
    skippedSymbols: [],
  };

  if (!process.env.DATABASE_URL) return empty;

  const { getPrisma } = await import("@/lib/db/prisma");
  const prisma = getPrisma();

  const newest = await prisma.rotationState.findFirst({ orderBy: { date: "desc" } });
  if (!newest) return empty;

  const latestDate = newest.date;
  const yearStart = new Date(Date.UTC(latestDate.getUTCFullYear(), 0, 1));
  const since = new Date(latestDate);
  since.setUTCDate(since.getUTCDate() - RECENT_SIGNAL_DAYS);

  // 三个查询都只依赖 latestDate，串行发到 Neon 会多花两个往返。
  const [rows, closedThisYear, signalRows] = await Promise.all([
    prisma.rotationState.findMany({ where: { date: latestDate } }),
    prisma.rotationTrade.findMany({
      where: { exitDate: { gte: yearStart } },
      select: { pnlPct: true },
    }),
    prisma.rotationState.findMany({
      where: { date: { gte: since }, OR: [{ buy1: true }, { buy2: true }] },
      orderBy: { date: "desc" },
      select: { date: true, symbol: true, buy1: true, rs: true, close: true },
    }),
  ]);

  // 满仓 RS 加权：权重只在持仓标的之间分配
  const active = rows.filter((r) => r.sigType > 0);
  const activeRsSum = active.reduce((sum, r) => sum + r.rs, 0);

  const toHolding = (row: (typeof rows)[number]): RotationHolding => {
    const weightPct = row.sigType > 0 && activeRsSum > 0 ? (row.rs / activeRsSum) * 100 : 0;
    return {
      symbol: row.symbol,
      close: row.close,
      rs: row.rs,
      sigType: row.sigType,
      entryPrice: row.entryPrice,
      effectiveStop: row.effectiveStop,
      floatPnlPct: row.floatPnlPct,
      maxPnlPct: row.maxPnlPct,
      breakevenLocked: row.breakevenLocked,
      weightPct,
      navContribPct: row.floatPnlPct * (weightPct / 100),
    };
  };

  const all = rows.map(toHolding).sort((a, b) => b.rs - a.rs);
  const holdings = all
    .filter((h) => h.sigType > 0)
    .sort((a, b) => b.weightPct - a.weightPct);

  const closedPnlSum = closedThisYear.reduce((sum, t) => sum + t.pnlPct, 0);
  const wins = closedThisYear.filter((t) => t.pnlPct > 0).length;
  const openNavPct = holdings.reduce((sum, h) => sum + h.navContribPct, 0);
  const closedNavPct = closedPnlSum / AVG_SLOTS;

  return {
    latestDate: latestDate.toISOString().slice(0, 10),
    holdings,
    all,
    recentSignals: signalRows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      symbol: r.symbol,
      sigType: r.buy1 ? 1 : 2,
      rs: r.rs,
      close: r.close,
    })),
    stats: {
      closedPnlSum,
      closedNavPct,
      openNavPct,
      totalNavPct: closedNavPct + openNavPct,
      trades: closedThisYear.length,
      wins,
      winRatePct: closedThisYear.length > 0 ? (wins / closedThisYear.length) * 100 : 0,
    },
    universeSize,
    skippedSymbols: ROTATION_UNIVERSE.filter(
      (t) => !rows.some((r) => r.symbol === t.symbol),
    ).map((t) => t.symbol),
  };
}
