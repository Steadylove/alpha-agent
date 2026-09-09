import { DEFAULT_LOOKBACK_SLOTS, isLookbackTf, type LookbackTf, type LookbackView } from "@/lib/fund/lookbackLogic";

export const LIVE_BOOKS: { tf: LookbackTf; name: string }[] = [
  { tf: "4h", name: "4 小时" },
  { tf: "2h", name: "2 小时" },
];

export function liveBookName(tf: LookbackTf): string {
  return LIVE_BOOKS.find((book) => book.tf === tf)?.name ?? tf;
}

export type LiveBookOk = { tf: LookbackTf; name: string; view: LookbackView; sparkline?: number[] };

export type LiveBookCache = {
  /** 旧缓存缺这些字段仍可展示，但不能当作最新结果使用。 */
  runId?: string;
  marketRevision?: string;
  strategyKey?: string;
  computedAt: string;
  epochFrom: string;
  poolKey: string;
  slots: number;
  books: LiveBookOk[];
};

export function livePoolKey(members: readonly string[]): string {
  return [...new Set(members.map((t) => t.trim().toUpperCase()))].sort().join(",");
}

/** 落盘留整条净值，去掉每日持仓明细和错过点。 */
export function slimLookbackView(view: LookbackView): LookbackView {
  const last = view.curve.length - 1;
  return {
    ...view,
    curve: view.curve.map((p, i) => ({
      date: p.date,
      equity: p.equity,
      exposurePct: p.exposurePct,
      buys: p.buys,
      sells: p.sells,
      rows: i === last ? (p.rows.length ? p.rows : view.rows) : [],
      misses: [],
    })),
    misses: [],
  };
}

function viewOf(raw: unknown): LookbackView | null {
  if (typeof raw !== "object" || raw == null) return null;
  const v = raw as LookbackView;
  if (typeof v.since !== "string" || typeof v.asOf !== "string") return null;
  if (typeof v.equity !== "number" || typeof v.pnl !== "string") return null;
  if (!Array.isArray(v.rows) || !Array.isArray(v.curve)) return null;
  if (typeof v.stats !== "object" || v.stats == null) return null;
  return { ...v, fills: Array.isArray(v.fills) ? v.fills : [] };
}

function bookOf(raw: unknown): LiveBookOk | null {
  if (typeof raw !== "object" || raw == null) return null;
  const row = raw as Partial<LiveBookOk>;
  if (!isLookbackTf(row.tf) || typeof row.name !== "string") return null;
  const view = viewOf(row.view);
  if (!view) return null;
  return {
    tf: row.tf,
    name: row.name,
    view,
    sparkline: Array.isArray(row.sparkline) ? row.sparkline.filter((n): n is number => typeof n === "number") : undefined,
  };
}

export function liveBookCacheOf(raw: unknown): LiveBookCache | null {
  if (typeof raw !== "object" || raw == null) return null;
  const row = raw as Partial<LiveBookCache>;
  if (typeof row.computedAt !== "string" || typeof row.epochFrom !== "string") return null;
  if (typeof row.poolKey !== "string") return null;
  const slots = typeof row.slots === "number" ? row.slots : DEFAULT_LOOKBACK_SLOTS;
  if (!Array.isArray(row.books)) return null;
  const books = row.books.map(bookOf).filter((b): b is LiveBookOk => b != null);
  if (books.length === 0) return null;
  return {
    computedAt: row.computedAt, epochFrom: row.epochFrom, poolKey: row.poolKey, slots, books,
    runId: typeof row.runId === "string" ? row.runId : undefined,
    marketRevision: typeof row.marketRevision === "string" ? row.marketRevision : undefined,
    strategyKey: typeof row.strategyKey === "string" ? row.strategyKey : undefined,
  };
}

export function isLiveBookFresh(
  cache: LiveBookCache,
  epochFrom: string,
  poolKey: string,
  slots = DEFAULT_LOOKBACK_SLOTS,
  revision?: { marketRevision: string; strategyKey: string; asOf: Partial<Record<LookbackTf, string>> },
): boolean {
  return (
    cache.epochFrom === epochFrom &&
    cache.poolKey === poolKey &&
    cache.slots === slots &&
    LIVE_BOOKS.every((want) => cache.books.some((b) => b.tf === want.tf)) &&
    (!revision || (
      Boolean(cache.runId) && cache.marketRevision === revision.marketRevision &&
      cache.strategyKey === revision.strategyKey &&
      cache.books.every((b) => !revision.asOf[b.tf] || b.view.asOf >= revision.asOf[b.tf]!)
    ))
  );
}

export type LiveBookVersion = Omit<LiveBookCache, "books"> & {
  id: string;
  books: { tf: LookbackTf; pnl: string; equity: number; dd: number; holdings: number; asOf: string }[];
};

export function liveBookVersion(cache: LiveBookCache, id: string): LiveBookVersion {
  return {
    ...cache, id,
    books: cache.books.map(({ tf, view }) => ({ tf, pnl: view.pnl, equity: view.equity, dd: view.stats.dd, holdings: view.rows.length, asOf: view.asOf })),
  };
}
