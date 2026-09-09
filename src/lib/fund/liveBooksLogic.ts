import { DEFAULT_LOOKBACK_SLOTS, isLookbackTf, type LookbackTf, type LookbackView } from "@/lib/fund/lookbackLogic";

export const LIVE_BOOKS: { tf: LookbackTf; name: string }[] = [
  { tf: "4h", name: "4 小时" },
  { tf: "2h", name: "2H 扩池" },
];

export type LiveBookOk = { tf: LookbackTf; name: string; view: LookbackView; sparkline?: number[] };

export type LiveBookCache = {
  computedAt: string;
  epochFrom: string;
  poolKey: string;
  slots: number;
  books: LiveBookOk[];
};

export function livePoolKey(members: readonly string[]): string {
  return [...members].map((t) => t.toUpperCase()).sort().join(",");
}

/** 页面只用期末持仓、成交和最后一根买卖，不存整条每日曲线。 */
export function slimLookbackView(view: LookbackView): LookbackView {
  const last = view.curve.at(-1);
  return {
    ...view,
    curve: last ? [{ ...last, rows: view.rows }] : [],
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
  return { computedAt: row.computedAt, epochFrom: row.epochFrom, poolKey: row.poolKey, slots, books };
}

export function isLiveBookFresh(
  cache: LiveBookCache,
  epochFrom: string,
  poolKey: string,
  slots = DEFAULT_LOOKBACK_SLOTS,
): boolean {
  return (
    cache.epochFrom === epochFrom &&
    cache.poolKey === poolKey &&
    cache.slots === slots &&
    LIVE_BOOKS.every((want) => cache.books.some((b) => b.tf === want.tf))
  );
}
