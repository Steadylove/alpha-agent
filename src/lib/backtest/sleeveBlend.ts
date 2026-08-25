import type {
  DayBook,
  HoldingDay,
  HoldingRow,
  PortfolioStats,
  TradeStats,
  WindowResult,
  YearRow,
  YearToDate,
} from "./engine";

export const SLEEVE_DAILY_W = 0.5;
export const SLEEVE_HOUR_W = 0.5;
export const SLEEVE_NAME_CAP = 0.15;

function combineTrade(a: TradeStats, b: TradeStats): TradeStats {
  const n = a.trades + b.trades;
  if (n === 0) return a;
  const w = (x: number, y: number) => (x * a.trades + y * b.trades) / n;
  return {
    trades: n,
    winRatePct: w(a.winRatePct, b.winRatePct),
    meanPnlPct: w(a.meanPnlPct, b.meanPnlPct),
    medianPnlPct: w(a.medianPnlPct, b.medianPnlPct),
    profitFactor: w(a.profitFactor, b.profitFactor),
    avgBarsHeld: w(a.avgBarsHeld, b.avgBarsHeld),
    worstPnlPct: Math.min(a.worstPnlPct, b.worstPnlPct),
    meanR: w(a.meanR, b.meanR),
    exits: {
      stop: a.exits.stop + b.exits.stop,
      target: a.exits.target + b.exits.target,
      veto: a.exits.veto + b.exits.veto,
      rsWeak: a.exits.rsWeak + b.exits.rsWeak,
    },
  };
}

function lastOfDay<T extends { date: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) out.set(row.date.slice(0, 10), row);
  return out;
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0] ?? 1;
  let dd = 0;
  for (const x of equity) {
    if (x > peak) peak = x;
    if (peak > 0) dd = Math.max(dd, 1 - x / peak);
  }
  return dd * 100;
}

function cagrPct(mult: number, firstDate: string, lastDate: string): number {
  const years = (Date.parse(lastDate.slice(0, 10)) - Date.parse(firstDate.slice(0, 10))) / (365.25 * 86400000);
  if (!(years > 0) || !(mult > 0)) return 0;
  return (mult ** (1 / years) - 1) * 100;
}

function volPct(equity: number[]): number {
  if (equity.length < 2) return 0;
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
  }
  if (rets.length === 0) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varr) * Math.sqrt(252) * 100;
}

function mergeRows(daily: HoldingRow[], hour: HoldingRow[], dw: number, hw: number): HoldingRow[] {
  const by = new Map<string, HoldingRow>();
  for (const r of daily) {
    by.set(r.symbol, { ...r, weightPct: dw * r.weightPct });
  }
  for (const r of hour) {
    const prev = by.get(r.symbol);
    if (prev) {
      by.set(r.symbol, {
        ...prev,
        weightPct: prev.weightPct + hw * r.weightPct,
      });
    } else {
      by.set(r.symbol, { ...r, weightPct: hw * r.weightPct });
    }
  }
  return [...by.values()].sort((a, b) => b.weightPct - a.weightPct);
}

function yearRows(book: DayBook[], dailyYears: YearRow[] = [], hourYears: YearRow[] = []): YearRow[] {
  const dailyTrades = new Map(dailyYears.map((r) => [r.year, r.trades]));
  const hourTrades = new Map(hourYears.map((r) => [r.year, r.trades]));
  const out: YearRow[] = [];
  for (let i = 0; i < book.length; ) {
    const year = book[i].date.slice(0, 4);
    let j = i;
    while (j < book.length && book[j].date.startsWith(year)) j += 1;
    const prevS = i === 0 ? 1 : book[i - 1].strategy;
    const prevB = i === 0 ? 1 : book[i - 1].benchmark;
    const prevQ = i === 0 ? 1 : (book[i - 1].spy ?? 1);
    const end = book[j - 1];
    const y = Number(year);
    out.push({
      year: y,
      trades: (dailyTrades.get(y) ?? 0) + (hourTrades.get(y) ?? 0),
      strategyPct: (end.strategy / prevS - 1) * 100,
      benchmarkPct: (end.benchmark / prevB - 1) * 100,
      spyPct: end.spy == null ? null : (end.spy / prevQ - 1) * 100,
      isOutOfSample: false,
    });
    i = j;
  }
  return out;
}

export type SleeveLegs = {
  book: DayBook[];
  holdings: HoldingDay[];
  byYear?: YearRow[];
  inSample: WindowResult;
  ytd: YearToDate | null;
};

export type SleeveBlend = {
  book: DayBook[];
  holdings: HoldingDay[];
  equity: { date: string; strategy: number; benchmark: number }[];
  byYear: YearRow[];
  ytd: YearToDate | null;
  inSample: WindowResult;
};

export function blendSleeve(
  daily: SleeveLegs,
  hour: SleeveLegs,
  dailyW = SLEEVE_DAILY_W,
  hourW = SLEEVE_HOUR_W,
): SleeveBlend {
  const hourBook = lastOfDay(hour.book);
  const hourHold = lastOfDay(hour.holdings);
  const dailyHold = lastOfDay(daily.holdings);
  const book: DayBook[] = [];
  const holdings: HoldingDay[] = [];

  for (const d of daily.book) {
    const day = d.date.slice(0, 10);
    const h = hourBook.get(day);
    if (!h) continue;
    const rows = mergeRows(
      dailyHold.get(day)?.rows ?? [],
      hourHold.get(day)?.rows ?? [],
      dailyW,
      hourW,
    );
    const exposurePct = rows.reduce((s, r) => s + r.weightPct, 0);
    book.push({
      date: day,
      strategy: dailyW * d.strategy + hourW * h.strategy,
      benchmark: dailyW * d.benchmark + hourW * h.benchmark,
      spy: d.spy != null && h.spy != null ? dailyW * d.spy + hourW * h.spy : (d.spy ?? h.spy),
      nHold: rows.length,
      exposurePct,
      buys: [...new Set([...d.buys, ...h.buys])].sort(),
      sells: [...new Set([...d.sells, ...h.sells])].sort(),
    });
    if (rows.length > 0) holdings.push({ date: day, rows });
  }

  const equity = book.map((b) => ({ date: b.date, strategy: b.strategy, benchmark: b.benchmark }));
  const byYear = yearRows(book, daily.byYear, hour.byYear);
  const first = book[0];
  const last = book[book.length - 1];
  const exposures = book.map((b) => b.exposurePct);
  const avgExposurePct =
    exposures.length === 0 ? 0 : exposures.reduce((a, b) => a + b, 0) / exposures.length;
  const investedDayPct =
    book.length === 0 ? 0 : (book.filter((b) => b.nHold > 0).length / book.length) * 100;

  const portfolio: PortfolioStats = {
    equity: last?.strategy ?? 1,
    cagrPct: first && last ? cagrPct(last.strategy, first.date, last.date) : 0,
    maxDrawdownPct: maxDrawdown(book.map((b) => b.strategy)),
    volPct: volPct(book.map((b) => b.strategy)),
    investedDayPct,
    avgExposurePct,
    days: book.length,
  };
  const benchmark: PortfolioStats = {
    equity: last?.benchmark ?? 1,
    cagrPct: first && last ? cagrPct(last.benchmark, first.date, last.date) : 0,
    maxDrawdownPct: maxDrawdown(book.map((b) => b.benchmark)),
    volPct: volPct(book.map((b) => b.benchmark)),
    investedDayPct: 100,
    avgExposurePct: 100,
    days: book.length,
  };

  const inSample: WindowResult = {
    label: "袖套 50/50 · 单票 15%",
    from: first?.date ?? daily.inSample.from,
    to: last?.date ?? daily.inSample.to,
    trade: combineTrade(daily.inSample.trade, hour.inSample.trade),
    portfolio,
    benchmark,
  };

  const ytdYear = last?.date.slice(0, 4) ?? "";
  const ytdLo = ytdYear ? book.findIndex((b) => b.date.startsWith(ytdYear)) : -1;
  const ytd: YearToDate | null =
    ytdLo >= 0 && last
      ? {
          year: Number(ytdYear),
          from: book[ytdLo].date,
          to: last.date,
          strategyPct: (last.strategy / (ytdLo === 0 ? 1 : book[ytdLo - 1].strategy) - 1) * 100,
          benchmarkPct: (last.benchmark / (ytdLo === 0 ? 1 : book[ytdLo - 1].benchmark) - 1) * 100,
          spyPct:
            last.spy == null
              ? null
              : (last.spy / (ytdLo === 0 ? 1 : (book[ytdLo - 1].spy ?? 1)) - 1) * 100,
          trades: (daily.ytd?.trades ?? 0) + (hour.ytd?.trades ?? 0),
        }
      : null;

  return { book, holdings, equity, byYear, ytd, inSample };
}
