import {
  MPR_SYMBOLS,
  alignMprInputs,
  computeMprSeries,
  type AlignBar,
  type MprDay,
  type MprSymbol,
} from "@/lib/scoring/mpr";

export type MprData = {
  latest: MprDay | null;
  /** 近端历史，最新的在最后。 */
  history: MprDay[];
  /** 缺失的标的，非空时说明还没跑 npm run backfill:macro。 */
  missingSymbols: string[];
};

/** 面板展示的历史长度。 */
const HISTORY_DAYS = 120;

/**
 * 预热所需的最少交易日：ECDF 的原始序列自身要 252 根才有值，分位再要 252 根。
 * 不足这个量算出来的是零填充的假分位——实测 400 根窗口会让近 60 天里 20 天的
 * 路径判定出错，600 根则与全历史逐位一致。
 */
const MIN_WARMUP_BARS = 252 * 2 + HISTORY_DAYS;

/**
 * 回溯年数。6 年约 1510 个交易日，是 MIN_WARMUP_BARS 的 2.4 倍，余量充足。
 * 不取全历史是因为 4.5 万行的传输会把页面从 0.7s 级拖到 2s 级。
 */
const LOOKBACK_YEARS = 6;

/**
 * 加载近端日线并逐日计算 MPR。
 *
 * 必须用单次批量查询：逐标的查要 11.5s，合并成一次是 1.55s，差在往返延迟。
 */
export async function getMprData(): Promise<MprData> {
  if (!process.env.DATABASE_URL) {
    return { latest: null, history: [], missingSymbols: [...MPR_SYMBOLS] };
  }

  const { getPrisma } = await import("@/lib/db/prisma");
  const prisma = getPrisma();

  const instruments = await prisma.instrument.findMany({
    where: { symbol: { in: [...MPR_SYMBOLS] } },
    select: { id: true, symbol: true },
  });

  const found = new Set(instruments.map((i) => i.symbol));
  const missingSymbols = MPR_SYMBOLS.filter((s) => !found.has(s));
  if (missingSymbols.length > 0) {
    return { latest: null, history: [], missingSymbols };
  }

  const since = new Date();
  since.setFullYear(since.getFullYear() - LOOKBACK_YEARS);

  const bars = await prisma.dailyBar.findMany({
    where: { instrumentId: { in: instruments.map((i) => i.id) }, date: { gte: since } },
    orderBy: { date: "asc" },
    select: { instrumentId: true, date: true, close: true, volume: true },
  });

  const symbolById = new Map(instruments.map((i) => [i.id, i.symbol as MprSymbol]));
  const bySymbol = {} as Record<MprSymbol, AlignBar[]>;
  for (const symbol of MPR_SYMBOLS) bySymbol[symbol] = [];
  for (const bar of bars) {
    const symbol = symbolById.get(bar.instrumentId);
    if (!symbol) continue;
    bySymbol[symbol].push({
      date: bar.date.toISOString().slice(0, 10),
      close: bar.close,
      volume: Number(bar.volume),
    });
  }

  const rows = alignMprInputs(bySymbol);
  if (rows.length < MIN_WARMUP_BARS) {
    // 预热不足时 ECDF 会输出零填充的假分位，宁可不显示也不给错的数
    return { latest: null, history: [], missingSymbols: [] };
  }

  const series = computeMprSeries(rows);
  const history = series.slice(-HISTORY_DAYS);

  return { latest: history.at(-1) ?? null, history, missingSymbols: [] };
}
