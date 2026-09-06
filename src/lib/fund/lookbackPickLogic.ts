export type ScoreRow = { ticker: string; eq: number; n: number };

export type LookbackPickTf = "4h" | "2h" | "both";

export function isLookbackPickTf(raw: unknown): raw is LookbackPickTf {
  return raw === "4h" || raw === "2h" || raw === "both";
}

export function clampPickSize(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 120) return null;
  return n;
}

/** 未平仓股价涨跌幅折成对净值的贡献，和 lotPnl 同一量级。 */
export function openBookPct(weightPct: number, floatPnlPct: number): number {
  if (floatPnlPct <= -100) return -weightPct;
  return (weightPct * floatPnlPct) / (100 + floatPnlPct);
}

/** 现金账本里实际持过仓的贡献：已平仓 lot + 期末浮盈（都是对净值的百分点）。 */
export function bookContrib(
  lots: readonly { symbol: string; pct: number }[],
  open: readonly { symbol: string; floatPnlPct: number; weightPct: number }[],
): ScoreRow[] {
  const pnl = new Map<string, number>();
  const n = new Map<string, number>();
  const add = (symbol: string, pct: number) => {
    pnl.set(symbol, (pnl.get(symbol) ?? 0) + pct);
    n.set(symbol, (n.get(symbol) ?? 0) + 1);
  };
  for (const x of lots) add(x.symbol, x.pct);
  const seen = new Set<string>();
  for (const r of open) {
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    add(r.symbol, openBookPct(r.weightPct, r.floatPnlPct));
  }
  return [...pnl.entries()]
    .map(([ticker, eq]) => ({ ticker, eq, n: n.get(ticker) ?? 0 }))
    .sort((a, b) => b.eq - a.eq || a.ticker.localeCompare(b.ticker));
}

export function pickByRank(a: readonly ScoreRow[], b: readonly ScoreRow[], n: number): string[] {
  if (a.length === 0) return b.slice(0, n).map((r) => r.ticker);
  if (b.length === 0) return a.slice(0, n).map((r) => r.ticker);
  const rank = new Map<string, number>();
  const add = (rows: readonly ScoreRow[]) => {
    rows.forEach((r, i) => rank.set(r.ticker, (rank.get(r.ticker) ?? 0) + (rows.length - i)));
  };
  add(a);
  add(b);
  return [...rank.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, n)
    .map(([t]) => t);
}