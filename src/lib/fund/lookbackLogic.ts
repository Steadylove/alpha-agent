import type { DayBook, HoldingDay, HoldingRow } from "@/lib/backtest/engine";

import { bookPnlLabel } from "@/lib/discord/bookCopy";

export type LookbackTf = "4h" | "2h";

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

export type LookbackView = {
  since: string;
  asOf: string;
  equity: number;
  pnl: string;
  exposurePct: number;
  curve: LookbackPoint[];
  rows: LookbackRow[];
  stats: LookbackStats;
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
  },
  since: string,
): LookbackView {
  const curve = dailyCurve(raw.book, raw.holdings);
  const last = curve.at(-1);
  const lastHold = raw.holdings.at(-1);
  const lastBook = raw.book.at(-1);
  const equity = last?.equity ?? lastBook?.strategy ?? 1;
  const ytd = ytdOfCurve(curve);
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
  };
}
