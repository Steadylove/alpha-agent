export type SignalPoolPatch = {
  added: string[];
  removed: string[];
  updatedAt: string;
};

const TICKER = /^[A-Z][A-Z0-9.]{0,9}$/;

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
  };
}

export function applySignalPool(base: readonly string[], patch: SignalPoolPatch): string[] {
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
    return { added: [...added].sort(), removed: [...removed].sort(), updatedAt: "" };
  }

  if (!members.has(sym)) throw new Error(`${sym} 不在池里`);
  added.delete(sym);
  if (inBase.has(sym)) removed.add(sym);
  return { added: [...added].sort(), removed: [...removed].sort(), updatedAt: "" };
}

export function isTickerInPool(symbol: string, members: readonly string[]): boolean {
  const ticker = normalizeTicker(symbol);
  return ticker != null && members.includes(ticker);
}
