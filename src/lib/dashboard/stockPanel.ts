import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { readSnapshot } from "@/lib/vps/snapshot";

/** StockPanelState 落库的字段子集，加上标的名。 */
export type StockPanelRow = {
  symbol: string;
  name: string;
  close: number;
  rs: number;
  rsAccelerating: boolean;
  /** MPR 口径的 4Q-Alpha 评分，驱动原版实战指引的弱势分支 */
  mprAlphaRs: number;
  inShortDowntrend: boolean;
  trendScore: number;
  stage: string;
  baseTier: string;
  baseDays: number;
  distFrom52wHigh: number;
  /** 布林带宽 / 肯特纳带宽，>1.35 触发 Stage W 高波震荡 */
  squeezeRatio: number;
  hurstReturn: number;
  hurstReturnRegime: string;
  hurstPrice: number;
  volatilityPattern: string;
  volumeRatio: number;
  moneyFlow: string;
  dipKind: string;
  dipQuality: string | null;
  dipLow: number | null;
  dipHigh: number | null;
  dipResistance: number | null;
  sectorId: string | null;
  sectorName: string | null;
  sectorRank: number | null;
  sectorStatus: string | null;
  buy1Signal: boolean;
  buy2Signal: boolean;
  smoothedRsi: number | null;
  buy1Entry: number | null;
  buy1Stop: number | null;
  buy1Trail: number | null;
  buy1Locked: boolean;
  buy2Entry: number | null;
  buy2Stop: number | null;
  buy2Trail: number | null;
  buy2Locked: boolean;
  tacticalAction: string;
  tacticalTone: string;
  tacticalLayer: string;
  /** 12M 估值引擎输出；基本面缺失或估值任务未跑时为 null */
  valuation: StockValuationCell | null;
};

/** 12M 动态估值引擎的面板投影，对齐 MarketCompass Pine 第 479~578 行。 */
export type StockValuationCell = {
  primaryTarget: number;
  upsidePct: number;
  mode: string;
  archetype: string;
  consensusSmoothed: boolean;
  currentPe: number | null;
  calculatedPe: number | null;
  marketCapB: number | null;
  isDipActive: boolean;
  /** 轧空短线目标价，close + 2×ATR×档位倍数 */
  shortTermTarget: number;
  squeezeTier: string;
  /** 空头持仓占在外股本的百分比；ETF 等无 SEC 申报的标的为 null */
  shortInterestPct: number | null;
  /** FINRA 结算日，双月一期且滞后 2~3 周，用于提示时效 */
  shortInterestDate: string | null;
  isInLongDowntrend: boolean;
  isHyperMomentum: boolean;
};

export type SectorClockRow = {
  sectorId: string;
  symbol: string;
  name: string;
  sls: number;
  mom21: number;
  rank: number;
  isTop3: boolean;
  isBottoming: boolean;
};

export type StockPanelData = {
  latestDate: string | null;
  /** 估值任务独立调度，日期可能落后于面板快照 */
  valuationDate: string | null;
  /** 当日 MPR 传导路径，原版实战指引按它分支 */
  pathId: number | null;
  rows: StockPanelRow[];
  /** 各形态阶段的当日标的数，按 A→B→W→E→D→C 排列。 */
  stageCounts: { stage: string; count: number }[];
  /** SLS 3.0 行业时钟，按名次升序。 */
  sectorClock: SectorClockRow[];
  /** 样本不足被跳过的标的（EMA576 需要至少 900 根日线）。 */
  skippedSymbols: string[];
  universeSize: number;
};

export async function getStockPanelData(): Promise<StockPanelData> {
  const universeSize = ROTATION_UNIVERSE.length;
  const empty: StockPanelData = {
    latestDate: null,
    valuationDate: null,
    pathId: null,
    rows: [],
    stageCounts: [],
    sectorClock: [],
    skippedSymbols: [],
    universeSize,
  };
  return (await readSnapshot<StockPanelData>("stock-panel")) ?? empty;
}
