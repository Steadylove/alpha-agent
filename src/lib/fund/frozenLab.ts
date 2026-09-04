import {
  prepareSymbolInputs,
  tradeParamsOf,
  windowBounds,
  type DayBook,
  type HoldingDay,
  type PreparedSymbol,
  type PreparedUniverse,
  type YearRow,
  type YearToDate,
} from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import { getQqqCloses, overlaySpyCurve } from "@/lib/backtest/spyCurve";
import {
  computeRotationTrades,
  type ClosedTrade,
  type TradeBar,
  type TradeDay,
} from "@/lib/scoring/rotationTrade";

import { champOf, type Champ } from "./champs";
import { runRotate } from "./rotate";

export type FrozenTrade = {
  symbol: string;
  sigType: 1 | 2;
  entryDate: string;
  exitDate: string;
  pnlPct: number;
};

export type FrozenLabResult = {
  champ: Pick<Champ, "id" | "name" | "note" | "label">;
  stats: {
    cagr: number;
    dd: number;
    mar: number;
    entries: number;
    rotations: number;
    missed: number;
    avgHoldings: number;
    avgExposure: number;
    tradesPerYear: number;
  };
  book: DayBook[];
  holdings: HoldingDay[];
  trades: FrozenTrade[];
  byYear: YearRow[];
  ytd: YearToDate | null;
  universeSize: number;
  elapsedMs: number;
};

const dayOf = (date: string) => date.slice(0, 10);

/** 盘中多根收成每个交易日最后一根，买卖合并到当日。 */
export function collapseBookDaily(book: DayBook[]): DayBook[] {
  const m = new Map<string, DayBook>();
  for (const d of book) {
    const date = dayOf(d.date);
    const prev = m.get(date);
    if (!prev) {
      m.set(date, { ...d, date, buys: [...d.buys], sells: [...d.sells] });
      continue;
    }
    m.set(date, {
      ...d,
      date,
      buys: [...prev.buys, ...d.buys],
      sells: [...prev.sells, ...d.sells],
    });
  }
  return [...m.values()];
}

export function collapseHoldingsDaily(holdings: HoldingDay[]): HoldingDay[] {
  const m = new Map<string, HoldingDay>();
  for (const h of holdings) {
    const date = dayOf(h.date);
    m.set(date, { date, rows: h.rows });
  }
  return [...m.values()];
}

/** 同池等权买入持有，按日历日最后一根计价。 */
export function fillEqualWeight(book: DayBook[], uni: PreparedUniverse): void {
  if (book.length === 0) return;
  const start = book[0].date;
  const n = uni.symbols.length;
  const lastPx = new Array<number>(n).fill(0);
  const basePx = new Array<number>(n).fill(0);
  const cursor = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i += 1) {
    const sym = uni.symbols[i];
    for (let k = 0; k < sym.axisIndex.length; k += 1) {
      const date = dayOf(uni.axis[sym.axisIndex[k]]);
      const px = sym.close[k];
      if (px <= 0) continue;
      if (date <= start) {
        basePx[i] = px;
        lastPx[i] = px;
        cursor[i] = k + 1;
      } else {
        break;
      }
    }
  }

  for (const d of book) {
    for (let i = 0; i < n; i += 1) {
      const sym = uni.symbols[i];
      while (cursor[i] < sym.axisIndex.length) {
        const date = dayOf(uni.axis[sym.axisIndex[cursor[i]]]);
        if (date > d.date) break;
        const px = sym.close[cursor[i]];
        if (px > 0) {
          lastPx[i] = px;
          if (basePx[i] <= 0) basePx[i] = px;
        }
        cursor[i] += 1;
      }
    }
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      if (basePx[i] > 0 && lastPx[i] > 0) {
        sum += lastPx[i] / basePx[i];
        count += 1;
      }
    }
    d.benchmark = count > 0 ? sum / count : 1;
  }
}

function lastWhere<T>(items: readonly T[], pred: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (pred(items[i])) return items[i];
  }
}

function retPct(end: number, prev: number): number {
  return prev > 0 ? (end / prev - 1) * 100 : 0;
}

export function byYearOf(book: DayBook[], trades: FrozenTrade[]): YearRow[] {
  const years = [...new Set(book.map((d) => Number(d.date.slice(0, 4))))];
  return years.map((year) => {
    const key = String(year);
    const end = lastWhere(book, (d) => d.date.startsWith(key));
    const prev = lastWhere(book, (d) => d.date < `${year}-01-01`);
    return {
      year,
      trades: trades.filter((t) => t.exitDate.startsWith(key)).length,
      strategyPct: end ? retPct(end.strategy, prev?.strategy ?? 1) : 0,
      benchmarkPct: end ? retPct(end.benchmark, prev?.benchmark ?? 1) : 0,
      spyPct: null,
      isOutOfSample: false,
    };
  });
}

export function ytdOf(book: DayBook[], trades: FrozenTrade[]): YearToDate | null {
  if (book.length === 0) return null;
  const last = book[book.length - 1];
  const year = Number(last.date.slice(0, 4));
  const from = `${year}-01-01`;
  const first = book.find((d) => d.date >= from);
  if (!first) return null;
  const prev = lastWhere(book, (d) => d.date < from);
  return {
    year,
    from: first.date,
    to: last.date,
    strategyPct: retPct(last.strategy, prev?.strategy ?? 1),
    benchmarkPct: retPct(last.benchmark, prev?.benchmark ?? 1),
    spyPct: null,
    trades: trades.filter((t) => t.exitDate >= from).length,
  };
}

function asTrades(raw: ClosedTrade[]): FrozenTrade[] {
  return raw.map((t) => ({
    symbol: t.symbol,
    sigType: t.sigType,
    entryDate: dayOf(t.entryDate),
    exitDate: dayOf(t.exitDate),
    pnlPct: t.pnlPct,
  }));
}

export async function runFrozenLab(id: string | null): Promise<FrozenLabResult> {
  const champ = champOf(id);
  const [uni, qqq] = await Promise.all([
    getPreparedUniverse("SMALLFUND", champ.config.timeframe, champ.poolId),
    getQqqCloses(),
  ]);
  const started = Date.now();
  const raw = runRotate(uni, champ.config, champ.opts);
  const book = collapseBookDaily(raw.book);
  fillEqualWeight(book, uni);
  const holdings = collapseHoldingsDaily(raw.holdings);
  const trades = asTrades(raw.trades);
  const byYear = byYearOf(book, trades);
  const ytd = ytdOf(book, trades);
  if (qqq) overlaySpyCurve(book, byYear, ytd, qqq);

  return {
    champ: { id: champ.id, name: champ.name, note: champ.note, label: champ.label },
    stats: {
      cagr: raw.cagr,
      dd: raw.dd,
      mar: raw.mar,
      entries: raw.entries,
      rotations: raw.rotations,
      missed: raw.missed,
      avgHoldings: raw.avgHoldings,
      avgExposure: raw.avgExposure,
      tradesPerYear: raw.tradesPerYear,
    },
    book,
    holdings,
    trades,
    byYear,
    ytd,
    universeSize: uni.symbols.length,
    elapsedMs: Date.now() - started,
  };
}

/** 单只标的按定档窗口跑状态机，给个股图用。 */
export function runChampSymbol(
  uni: PreparedUniverse,
  champ: Champ,
  ticker: string,
): {
  sym: PreparedSymbol;
  lo: number;
  hi: number;
  bars: TradeBar[];
  days: TradeDay[];
  closed: ClosedTrade[];
} | null {
  const sym = uni.symbols.find((s) => s.ticker === ticker);
  if (!sym) return null;

  const { lo, hi } = windowBounds(uni.axis, champ.config);
  const isDayClose = uni.axis.map(
    (a, i) => i + 1 >= uni.axis.length || uni.axis[i + 1].slice(0, 10) !== a.slice(0, 10),
  );
  const inp = prepareSymbolInputs(uni.axis, sym, champ.config, lo, hi);

  if (champ.opts.entryWindow === "dayClose") {
    for (let k = 0; k < inp.buy1.length; k += 1) {
      if (isDayClose[sym.axisIndex[k]]) continue;
      inp.buy1[k] = false;
      inp.buy2[k] = false;
    }
  }

  const { days, closed } = computeRotationTrades(
    sym.ticker,
    inp.bars,
    inp.buy1,
    inp.buy2,
    inp.rs,
    {
      ...tradeParamsOf(champ.config),
      ...(champ.opts.exitWindow === "dayClose"
        ? { exitGate: (k: number) => isDayClose[sym.axisIndex[k]] }
        : {}),
    },
  );

  return { sym, lo, hi, bars: inp.bars, days, closed };
}
