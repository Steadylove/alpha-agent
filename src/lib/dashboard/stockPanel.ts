import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";

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

const STAGE_ORDER = ["A", "B", "W", "E", "D", "C"];

type StockValuationRow = {
  primaryTarget: number;
  upsidePct: number;
  mode: string;
  archetype: string;
  consensusSmoothed: boolean;
  currentPe: number | null;
  calculatedPe: number | null;
  marketCapB: number | null;
  isDipActive: boolean;
  shortTermTarget: number;
  squeezeTier: string;
  isInLongDowntrend: boolean;
  isHyperMomentum: boolean;
};

function valuationCell(
  v: StockValuationRow | undefined,
  si: { settlementDate: Date; sharesShort: number; sharesOutstanding: number | null } | undefined,
): StockValuationCell | null {
  if (!v) return null;
  return {
    shortInterestPct:
      si?.sharesOutstanding != null && si.sharesOutstanding > 0
        ? (si.sharesShort / si.sharesOutstanding) * 100
        : null,
    shortInterestDate: si?.settlementDate.toISOString().slice(0, 10) ?? null,
    primaryTarget: v.primaryTarget,
    upsidePct: v.upsidePct,
    mode: v.mode,
    archetype: v.archetype,
    consensusSmoothed: v.consensusSmoothed,
    currentPe: v.currentPe,
    calculatedPe: v.calculatedPe,
    marketCapB: v.marketCapB,
    isDipActive: v.isDipActive,
    shortTermTarget: v.shortTermTarget,
    squeezeTier: v.squeezeTier,
    isInLongDowntrend: v.isInLongDowntrend,
    isHyperMomentum: v.isHyperMomentum,
  };
}

/**
 * 读取 stock-panel 任务落库的个股快照。
 *
 * 与轮动看板同理，页面不做实时计算：35 只标的的全历史要拉十几万行日线，
 * 且 Hurst 与筑底天数都是跨日递推的，无法只取尾部窗口。
 */
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

  if (!process.env.DATABASE_URL) return empty;

  const { getPrisma } = await import("@/lib/db/prisma");
  const prisma = getPrisma();

  const newest = await prisma.stockPanelState.findFirst({ orderBy: { date: "desc" } });
  if (!newest) return empty;

  const [states, clock, newestValuation, phase] = await Promise.all([
    prisma.stockPanelState.findMany({ where: { date: newest.date } }),
    prisma.sectorClockState.findMany({ where: { date: newest.date }, orderBy: { rank: "asc" } }),
    // 估值任务与面板任务独立调度，取各自最新的一天而非强制同日
    prisma.stockValuation.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
    prisma.macroPhaseState.findFirst({ orderBy: { date: "desc" }, select: { pathId: true } }),
  ]);

  const [valuations, newestSettlement] = await Promise.all([
    newestValuation
      ? prisma.stockValuation.findMany({ where: { date: newestValuation.date } })
      : [],
    // 只要最新一期：全表会随每两周一期无限增长
    prisma.shortInterest.findFirst({
      orderBy: { settlementDate: "desc" },
      select: { settlementDate: true },
    }),
  ]);
  const valuationBySymbol = new Map(valuations.map((v) => [v.symbol, v]));

  const shortInterest = newestSettlement
    ? await prisma.shortInterest.findMany({
        where: { settlementDate: newestSettlement.settlementDate },
      })
    : [];
  const shortBySymbol = new Map(shortInterest.map((r) => [r.symbol, r]));
  const nameBySymbol = new Map(ROTATION_UNIVERSE.map((t) => [t.symbol, t.name]));
  const sectorNameById = new Map(SECTOR_UNIVERSE.map((s) => [s.id as string, s.name]));

  const rows: StockPanelRow[] = states
    .map((s) => ({
      symbol: s.symbol,
      name: nameBySymbol.get(s.symbol) ?? s.symbol,
      close: s.close,
      rs: s.rs,
      rsAccelerating: s.rsAccelerating,
      mprAlphaRs: s.mprAlphaRs,
      inShortDowntrend: s.inShortDowntrend,
      trendScore: s.trendScore,
      stage: s.stage,
      baseTier: s.baseTier,
      baseDays: s.baseDays,
      distFrom52wHigh: s.distFrom52wHigh,
      squeezeRatio: s.squeezeRatio,
      hurstReturn: s.hurstReturn,
      hurstReturnRegime: s.hurstReturnRegime,
      hurstPrice: s.hurstPrice,
      volatilityPattern: s.volatilityPattern,
      volumeRatio: s.volumeRatio,
      moneyFlow: s.moneyFlow,
      dipKind: s.dipKind,
      dipQuality: s.dipQuality,
      dipLow: s.dipLow,
      dipHigh: s.dipHigh,
      dipResistance: s.dipResistance,
      sectorId: s.sectorId,
      sectorName: s.sectorId ? (sectorNameById.get(s.sectorId) ?? null) : null,
      sectorRank: s.sectorRank,
      sectorStatus: s.sectorStatus,
      buy1Signal: s.buy1Signal,
      buy2Signal: s.buy2Signal,
      smoothedRsi: s.smoothedRsi,
      buy1Entry: s.buy1Entry,
      buy1Stop: s.buy1Stop,
      buy1Trail: s.buy1Trail,
      buy1Locked: s.buy1Locked,
      buy2Entry: s.buy2Entry,
      buy2Stop: s.buy2Stop,
      buy2Trail: s.buy2Trail,
      buy2Locked: s.buy2Locked,
      tacticalAction: s.tacticalAction,
      tacticalTone: s.tacticalTone,
      tacticalLayer: s.tacticalLayer,
      valuation: valuationCell(valuationBySymbol.get(s.symbol), shortBySymbol.get(s.symbol)),
    }))
    .sort((a, b) => b.rs - a.rs);

  const stageCounts = STAGE_ORDER.map((stage) => ({
    stage,
    count: rows.filter((r) => r.stage === stage).length,
  })).filter((s) => s.count > 0);

  return {
    latestDate: newest.date.toISOString().slice(0, 10),
    valuationDate: newestValuation?.date.toISOString().slice(0, 10) ?? null,
    pathId: phase?.pathId ?? null,
    rows,
    stageCounts,
    sectorClock: clock.map((c) => ({
      sectorId: c.sectorId,
      symbol: c.symbol,
      name: sectorNameById.get(c.sectorId) ?? c.sectorId,
      sls: c.sls,
      mom21: c.mom21,
      rank: c.rank,
      isTop3: c.isTop3,
      isBottoming: c.isBottoming,
    })),
    skippedSymbols: ROTATION_UNIVERSE.filter(
      (t) => !states.some((s) => s.symbol === t.symbol),
    ).map((t) => t.symbol),
    universeSize,
  };
}
