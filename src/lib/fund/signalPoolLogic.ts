import { poolRevisionsOf, type PoolRevision } from "./poolTimeline";

export type SignalPoolPatch = {
  added: string[];
  removed: string[];
  updatedAt: string;
  /** 有这份就以它为准，默认池以后再扩也不会漏进新票。 */
  members?: string[];
  revisions?: PoolRevision[];
};

const TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;

export function emptySignalPool(): SignalPoolPatch {
  return { added: [], removed: [], updatedAt: "" };
}

/** TV 有时带交易所前缀。`BRK.B` 合法。 */
export function normalizeTicker(raw: string): string | null {
  const ticker = raw.trim().toUpperCase().replace(/^.*:/, "");
  return TICKER.test(ticker) ? ticker : null;
}

function uniqTickers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const ticker = normalizeTicker(item);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    out.push(ticker);
  }
  return out.sort();
}

export function signalPoolOf(raw: unknown): SignalPoolPatch {
  if (typeof raw !== "object" || raw === null) return emptySignalPool();
  const p = raw as Partial<SignalPoolPatch>;
  return {
    added: uniqTickers(p.added),
    removed: uniqTickers(p.removed),
    updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : "",
    members: Array.isArray(p.members) ? uniqTickers(p.members) : undefined,
    ...(p.revisions ? { revisions: poolRevisionsOf(p.revisions) } : {}),
  };
}

function applyAddedRemoved(base: readonly string[], patch: Pick<SignalPoolPatch, "added" | "removed">): string[] {
  const removed = new Set(patch.removed);
  const have = new Set<string>();
  const out: string[] = [];
  for (const ticker of base) {
    if (removed.has(ticker) || have.has(ticker)) continue;
    have.add(ticker);
    out.push(ticker);
  }
  for (const ticker of patch.added) {
    if (have.has(ticker)) continue;
    have.add(ticker);
    out.push(ticker);
  }
  return out.sort();
}

export function applySignalPool(base: readonly string[], patch: SignalPoolPatch): string[] {
  if (patch.members != null) return uniqTickers(patch.members);
  return applyAddedRemoved(base, patch);
}

export function editSignalPool(
  base: readonly string[],
  patch: SignalPoolPatch,
  action: "add" | "remove" | "reset",
  ticker?: string,
): SignalPoolPatch {
  if (action === "reset") return emptySignalPool();
  const sym = normalizeTicker(ticker ?? "");
  if (!sym) throw new Error("标的代码不合法");

  const members = new Set(applySignalPool(base, patch));
  const added = new Set(patch.added);
  const removed = new Set(patch.removed);
  const inBase = new Set(base);

  if (action === "add") {
    if (members.has(sym)) throw new Error(`${sym} 已在池里`);
    removed.delete(sym);
    if (!inBase.has(sym)) added.add(sym);
    const next = { added: [...added].sort(), removed: [...removed].sort(), updatedAt: "" };
    return { ...next, members: applyAddedRemoved(base, next) };
  }

  if (!members.has(sym)) throw new Error(`${sym} 不在池里`);
  added.delete(sym);
  if (inBase.has(sym)) removed.add(sym);
  const next = { added: [...added].sort(), removed: [...removed].sort(), updatedAt: "" };
  return { ...next, members: applyAddedRemoved(base, next) };
}

export function isTickerInPool(symbol: string, members: readonly string[]): boolean {
  const ticker = normalizeTicker(symbol);
  return ticker != null && members.includes(ticker);
}

/** 逗号、空格、换行、分号都能拆。 */
export function parseTickers(text: string): { ok: string[]; bad: string[] } {
  const seen = new Set<string>();
  const ok: string[] = [];
  const bad: string[] = [];
  for (const part of text.split(/[\s,;|]+/).filter(Boolean)) {
    const ticker = normalizeTicker(part);
    if (!ticker) {
      bad.push(part.toUpperCase());
      continue;
    }
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    ok.push(ticker);
  }
  return { ok, bad };
}

export function tickerListOf(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return undefined;
  return uniqTickers(raw);
}

export function replaceSignalPool(base: readonly string[], members: readonly string[]): SignalPoolPatch {
  const want = new Set(uniqTickers(members));
  const inBase = new Set(base);
  return {
    added: [...want].filter((t) => !inBase.has(t)).sort(),
    removed: base.filter((t) => !want.has(t)).sort(),
    members: [...want].sort(),
    updatedAt: "",
  };
}

export function editSignalPoolMany(
  base: readonly string[],
  patch: SignalPoolPatch,
  action: "add" | "remove",
  tickers: readonly string[],
): SignalPoolPatch {
  let next = patch;
  for (const raw of tickers) {
    try {
      next = editSignalPool(base, next, action, raw);
    } catch {
      // 已在池里 / 不在池里 / 非法代码：批量时跳过
    }
  }
  return next;
}

/** 从接口 payload 还原默认基线，避免再传 560 只。 */
export function baseOfPool(pool: {
  members: readonly string[];
  added: readonly string[];
  removed: readonly string[];
}): string[] {
  const extra = new Set(pool.added);
  return [...new Set([...pool.members.filter((m) => !extra.has(m)), ...pool.removed])].sort();
}
