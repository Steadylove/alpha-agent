import { COMMERCIAL_SPEC } from "@/lib/config/commercialSpec";
import { hasDatabase } from "@/lib/db/remote";
import { PATH_EXPOSURE, type PathExposure, macroExposurePct } from "@/lib/scoring/macroExposure";
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

/** 净值曲线上的一天。 */
export type NavPoint = {
  date: string;
  /** 净值（%）=（已落袋累计 + 当日未平仓浮盈）/ 8 个等权仓位。 */
  navPct: number;
  /** 相对历史最高净值的回撤（%，非正数）。 */
  drawdownPct: number;
  holdings: number;
};

export type RotationData = {
  latestDate: string | null;
  holdings: RotationHolding[];
  /** 全部 40 只的最新状态，含空仓。 */
  all: RotationHolding[];
  recentSignals: RecentSignal[];
  stats: RotationStats;
  /** 年初至今的逐日净值，8 仓等权口径，与 stats.totalNavPct 不同尺度。 */
  navCurve: NavPoint[];
  /** 净值曲线上的最大回撤（%，非正数）。 */
  maxDrawdownPct: number;
  universeSize: number;
  /** 样本不足被跳过的标的。 */
  skippedSymbols: string[];
  /**
   * MPR 给出的建议总敞口，仅作提示。
   *
   * 刻意不参与仓位计算：组合层回测（3927 日、已去除未来函数）显示照此机械减仓
   * 会让收益/波动从 1.18 降到 0.95，得不偿失。详见 roadmap Phase 4。
   */
  macroExposure: (PathExposure & { pathId: number }) | null;
};

/** 与 Pine 的 avg_slots 一致：把单票收益摊薄到组合口径的除数。 */
const AVG_SLOTS = 8;
const RECENT_SIGNAL_DAYS = 30;

/**
 * 把逐日的个股快照与已平仓记录还原成组合净值曲线。
 *
 * 全程按 AVG_SLOTS 个等权仓位记账：已落袋和未平仓的单票收益都除以 8。
 * 这里刻意不沿用 stats.openNavPct 的 RS 满仓加权——那个口径把权重只分配给
 * 当日持仓，持仓从 8 只掉到 2 只时每只的权重会从 12% 跳到 50%，
 * 拉成时间序列后一只 +180% 的浮盈能把净值顶到 +187% 再砸回来，
 * 得到的「回撤」是持仓数变化的假象而非真实亏损。
 *
 * 代价是曲线末点与看板顶部的「全口径 YTD」不相等：后者的已落袋按 8 仓摊薄、
 * 浮盈却按满仓加权，两半本就不同尺度。
 */
function buildNavCurve(
  states: { date: Date; rs: number; sigType: number; floatPnlPct: number }[],
  closedTrades: { exitDate: Date; pnlPct: number }[],
): { navCurve: NavPoint[]; maxDrawdownPct: number } {
  if (states.length === 0) return { navCurve: [], maxDrawdownPct: 0 };

  const byDate = new Map<number, typeof states>();
  for (const s of states) {
    const key = s.date.getTime();
    const bucket = byDate.get(key);
    if (bucket) bucket.push(s);
    else byDate.set(key, [s]);
  }

  const exits = [...closedTrades].sort((a, b) => a.exitDate.getTime() - b.exitDate.getTime());
  let exitIdx = 0;
  let closedCum = 0;
  let peak = 0;
  let maxDrawdownPct = 0;

  const navCurve: NavPoint[] = [];
  for (const key of [...byDate.keys()].sort((a, b) => a - b)) {
    // 平仓当日这只票仍带着最终浮盈留在持仓快照里，收益要从次日才转入已落袋，
    // 否则平仓那天会被浮盈与已落袋各记一次。
    while (exitIdx < exits.length && exits[exitIdx].exitDate.getTime() < key) {
      closedCum += exits[exitIdx].pnlPct;
      exitIdx += 1;
    }

    const day = byDate.get(key)!;
    const active = day.filter((s) => s.sigType > 0);
    const openSum = active.reduce((sum, s) => sum + s.floatPnlPct, 0);

    const navPct = (closedCum + openSum) / AVG_SLOTS;
    peak = Math.max(peak, navPct);
    const drawdownPct = navPct - peak;
    maxDrawdownPct = Math.min(maxDrawdownPct, drawdownPct);

    navCurve.push({
      date: new Date(key).toISOString().slice(0, 10),
      navPct,
      drawdownPct,
      holdings: active.length,
    });
  }

  return { navCurve, maxDrawdownPct };
}

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
    navCurve: [],
    maxDrawdownPct: 0,
    universeSize,
    skippedSymbols: [],
    macroExposure: null,
  };

  if (!hasDatabase()) return empty;

  const { getPrisma } = await import("@/lib/db/prisma");
  const prisma = getPrisma();

  const newest = await prisma.rotationState.findFirst({ orderBy: { date: "desc" } });
  if (!newest) return empty;

  const latestDate = newest.date;
  const yearStart = new Date(Date.UTC(latestDate.getUTCFullYear(), 0, 1));
  const since = new Date(latestDate);
  since.setUTCDate(since.getUTCDate() - RECENT_SIGNAL_DAYS);

  // 这些查询都只依赖 latestDate，串行发到 Neon 会多花几个往返。
  const [rows, closedThisYear, signalRows, macroLatest, ytdStates] = await Promise.all([
    prisma.rotationState.findMany({ where: { date: latestDate } }),
    prisma.rotationTrade.findMany({
      where: { exitDate: { gte: yearStart } },
      select: { exitDate: true, pnlPct: true },
    }),
    prisma.rotationState.findMany({
      where: { date: { gte: since }, OR: [{ buy1: true }, { buy2: true }] },
      orderBy: { date: "desc" },
      select: { date: true, symbol: true, buy1: true, rs: true, close: true },
    }),
    prisma.macroPhaseState.findFirst({
      orderBy: { date: "desc" },
      select: { pathId: true },
    }),
    prisma.rotationState.findMany({
      where: { date: { gte: yearStart } },
      select: { date: true, rs: true, sigType: true, floatPnlPct: true },
      orderBy: { date: "asc" },
    }),
  ]);

  // 满仓 RS 加权：权重只在持仓标的之间分配
  const active = rows.filter((r) => r.sigType > 0);
  const activeRsSum = active.reduce((sum, r) => sum + r.rs, 0);

  // 商业化文档的 W_i = E_macro(Path) × RS_i/ΣRS_j。默认关闭，见 commercialSpec 注释：
  // 组合层回测显示照此机械减仓会让收益/波动从 1.18 降到 0.95。
  const exposureScale =
    COMMERCIAL_SPEC.macroExposureScaling && macroLatest != null
      ? macroExposurePct(macroLatest.pathId) / 100
      : 1;

  const toHolding = (row: (typeof rows)[number]): RotationHolding => {
    const weightPct =
      row.sigType > 0 && activeRsSum > 0 ? (row.rs / activeRsSum) * 100 * exposureScale : 0;
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

  const { navCurve, maxDrawdownPct } = buildNavCurve(ytdStates, closedThisYear);

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
    navCurve,
    maxDrawdownPct,
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
    macroExposure:
      macroLatest == null
        ? null
        : { pathId: macroLatest.pathId, ...(PATH_EXPOSURE[macroLatest.pathId] ?? PATH_EXPOSURE[4]) },
  };
}
