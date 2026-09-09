import type { PathExposure } from "@/lib/scoring/macroExposure";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { readSnapshot } from "@/lib/vps/snapshot";

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

const EMPTY_STATS: RotationStats = {
  closedPnlSum: 0,
  closedNavPct: 0,
  openNavPct: 0,
  totalNavPct: 0,
  trades: 0,
  wins: 0,
  winRatePct: 0,
};

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
  return (await readSnapshot<RotationData>("rotation")) ?? empty;
}
