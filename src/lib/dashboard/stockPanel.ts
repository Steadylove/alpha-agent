import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";

/** StockPanelState 落库的字段子集，加上标的名。 */
export type StockPanelRow = {
  symbol: string;
  name: string;
  close: number;
  rs: number;
  rsAccelerating: boolean;
  trendScore: number;
  stage: string;
  baseTier: string;
  baseDays: number;
  distFrom52wHigh: number;
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

  const [states, clock] = await Promise.all([
    prisma.stockPanelState.findMany({ where: { date: newest.date } }),
    prisma.sectorClockState.findMany({ where: { date: newest.date }, orderBy: { rank: "asc" } }),
  ]);
  const nameBySymbol = new Map(ROTATION_UNIVERSE.map((t) => [t.symbol, t.name]));
  const sectorNameById = new Map(SECTOR_UNIVERSE.map((s) => [s.id as string, s.name]));

  const rows: StockPanelRow[] = states
    .map((s) => ({
      symbol: s.symbol,
      name: nameBySymbol.get(s.symbol) ?? s.symbol,
      close: s.close,
      rs: s.rs,
      rsAccelerating: s.rsAccelerating,
      trendScore: s.trendScore,
      stage: s.stage,
      baseTier: s.baseTier,
      baseDays: s.baseDays,
      distFrom52wHigh: s.distFrom52wHigh,
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
    }))
    .sort((a, b) => b.rs - a.rs);

  const stageCounts = STAGE_ORDER.map((stage) => ({
    stage,
    count: rows.filter((r) => r.stage === stage).length,
  })).filter((s) => s.count > 0);

  return {
    latestDate: newest.date.toISOString().slice(0, 10),
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
