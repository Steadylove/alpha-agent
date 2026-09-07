import type { DayBook, HoldingDay, HoldingRow } from "@/lib/backtest/engine";

import { bookPnlLabel } from "@/lib/discord/bookCopy";

export type LookbackTf = "4h" | "2h";

/** 回看默认最多同时持有 10 只，每笔投 1/N。 */
export const DEFAULT_LOOKBACK_SLOTS = 10;

export function clampLookbackSlots(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 20) return null;
  return n;
}

export type LookbackRow = {
  symbol: string;
  floatPnlPct: number;
  entryPrice: number;
  weightPct: number;
  rps: number | null;
};

export type LookbackPoint = {
  date: string;
  equity: number;
  exposurePct: number;
  rows: LookbackRow[];
  buys: string[];
  sells: string[];
  misses: LookbackMiss[];
};

export type LookbackStats = {
  cagr: number;
  dd: number;
  mar: number;
  entries: number;
  rotations: number;
  avgHoldings: number;
  avgExposure: number;
  tradesPerYear: number;
  ytdYear: number | null;
  ytdPct: number | null;
};

export type LookbackMiss = {
  date: string;
  symbol: string;
  laterPct: number;
};

export type LookbackView = {
  since: string;
  asOf: string;
  equity: number;
  pnl: string;
  exposurePct: number;
  curve: LookbackPoint[];
  rows: LookbackRow[];
  stats: LookbackStats;
  misses: LookbackMiss[];
};

export function isLookbackTf(raw: unknown): raw is LookbackTf {
  return raw === "4h" || raw === "2h";
}

function uniq(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function toRow(h: HoldingRow): LookbackRow {
  return {
    symbol: h.symbol,
    floatPnlPct: h.floatPnlPct,
    entryPrice: h.entryPrice,
    weightPct: h.weightPct,
    rps: h.rps ?? h.entryRps,
  };
}

/** 4H/2H 按日历日只留当天最后一根，并带上当时持仓。 */
export function dailyCurve(
  book: readonly DayBook[],
  holdings: readonly HoldingDay[] = [],
): LookbackPoint[] {
  const holds = new Map<string, LookbackRow[]>();
  for (const day of holdings) holds.set(day.date.slice(0, 10), day.rows.map(toRow));
  const last = new Map<string, LookbackPoint>();
  for (const row of book) {
    const date = row.date.slice(0, 10);
    const prev = last.get(date);
    last.set(date, {
      date,
      equity: row.strategy,
      exposurePct: row.exposurePct,
      rows: holds.get(date) ?? [],
      buys: uniq([...(prev?.buys ?? []), ...row.buys]),
      sells: uniq([...(prev?.sells ?? []), ...row.sells]),
      misses: [],
    });
  }
  return [...last.values()];
}

/** 年末净值作基数；窗口从年中起步则相对 1。 */
export function ytdOfCurve(curve: readonly LookbackPoint[]): { year: number; pct: number } | null {
  const last = curve.at(-1);
  if (!last) return null;
  const year = Number(last.date.slice(0, 4));
  const from = `${year}-01-01`;
  if (!curve.some((p) => p.date >= from)) return null;
  const prev = [...curve].reverse().find((p) => p.date < from);
  return { year, pct: (last.equity / (prev?.equity ?? 1) - 1) * 100 };
}

export function lookbackView(
  raw: {
    book: readonly DayBook[];
    holdings: readonly HoldingDay[];
    cagr?: number;
    dd?: number;
    mar?: number;
    entries?: number;
    rotations?: number;
    avgHoldings?: number;
    avgExposure?: number;
    tradesPerYear?: number;
    missedBuys?: readonly { date: string; symbol: string; price: number }[];
    lastClose?: ReadonlyMap<string, number>;
  },
  since: string,
): LookbackView {
  const curve = dailyCurve(raw.book, raw.holdings);
  const last = curve.at(-1);
  const lastHold = raw.holdings.at(-1);
  const lastBook = raw.book.at(-1);
  const equity = last?.equity ?? lastBook?.strategy ?? 1;
  const ytd = ytdOfCurve(curve);
  const misses = goodMisses(raw.missedBuys ?? [], raw.lastClose ?? new Map(), curve);
  if (misses.length) {
    const byDay = new Map<string, LookbackMiss[]>();
    for (const m of misses) {
      const list = byDay.get(m.date) ?? [];
      list.push(m);
      byDay.set(m.date, list);
    }
    for (const p of curve) p.misses = byDay.get(p.date) ?? [];
  }
  return {
    since,
    asOf: lastHold?.date ?? lastBook?.date ?? "",
    equity,
    pnl: bookPnlLabel(equity),
    exposurePct: last?.exposurePct ?? lastBook?.exposurePct ?? 0,
    curve,
    rows: last?.rows ?? [],
    stats: {
      cagr: raw.cagr ?? 0,
      dd: raw.dd ?? 0,
      mar: raw.mar ?? 0,
      entries: raw.entries ?? 0,
      rotations: raw.rotations ?? 0,
      avgHoldings: raw.avgHoldings ?? 0,
      avgExposure: raw.avgExposure ?? 0,
      tradesPerYear: raw.tradesPerYear ?? 0,
      ytdYear: ytd?.year ?? null,
      ytdPct: ytd?.pct ?? null,
    },
    misses,
  };
}

/** 满仓错过的买点：同一票只记第一次，期末涨幅要高于从那天起的净值。 */
export function goodMisses(
  missed: readonly { date: string; symbol: string; price: number }[],
  lastClose: ReadonlyMap<string, number>,
  curve: readonly LookbackPoint[],
): LookbackMiss[] {
  const eqOn = new Map<string, number>();
  for (const p of curve) eqOn.set(p.date, p.equity);
  const lastEq = curve.at(-1)?.equity ?? 1;
  const seen = new Set<string>();
  const out: LookbackMiss[] = [];
  for (const m of missed) {
    if (seen.has(m.symbol) || m.price <= 0) continue;
    const close = lastClose.get(m.symbol);
    if (close == null || close <= 0) continue;
    const laterPct = (close / m.price - 1) * 100;
    const base = eqOn.get(m.date.slice(0, 10)) ?? 1;
    const bookPct = base > 0 ? (lastEq / base - 1) * 100 : 0;
    if (laterPct <= 0 || laterPct <= bookPct) continue;
    seen.add(m.symbol);
    out.push({ date: m.date.slice(0, 10), symbol: m.symbol, laterPct });
  }
  return out.sort((a, b) => b.laterPct - a.laterPct);
}
