import path from "node:path";

import { fetchAlpaca30MBars } from "@/lib/data-sources/alpaca";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import { aggregateTo4H, barTimeISO } from "@/lib/data-sources/yahooIntraday";

import { CSV_4H_DIR, CSV_PANEL_DIR, readCsvPanel, writeCsvPanel } from "./csvPanel";
import type { DayBook, YearRow, YearToDate } from "./engine";

export const SPY_CSV_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "benchmarks");

function closesFromPanel(dates: string[], close: Float32Array): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < dates.length; i += 1) {
    if (close[i] > 0) m.set(dates[i], close[i]);
  }
  return m;
}

let cached: Promise<Map<string, number> | null> | null = null;
let cached4h: Promise<Map<string, number> | null> | null = null;
let cachedQqq: Promise<Map<string, number> | null> | null = null;
let cachedQqq4h: Promise<Map<string, number> | null> | null = null;

/** 进程内只拉一次。本地 CSV 优先，没有再问 Yahoo 并落盘。 */
export function getSpyCloses(): Promise<Map<string, number> | null> {
  cached ??= loadSpyCloses().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}

export function getSpyCloses4h(): Promise<Map<string, number> | null> {
  cached4h ??= loadSpyCloses4h().catch((error) => {
    cached4h = null;
    throw error;
  });
  return cached4h;
}

/** Small Fund 对外基准。QQQ 已在池 CSV 里，只读本地，不另拉。 */
export function getQqqCloses(): Promise<Map<string, number> | null> {
  cachedQqq ??= loadQqqCloses().catch((error) => {
    cachedQqq = null;
    throw error;
  });
  return cachedQqq;
}

export function getQqqCloses4h(): Promise<Map<string, number> | null> {
  cachedQqq4h ??= loadQqqCloses4h().catch((error) => {
    cachedQqq4h = null;
    throw error;
  });
  return cachedQqq4h;
}

export async function loadQqqCloses(): Promise<Map<string, number> | null> {
  const local = readCsvPanel(CSV_PANEL_DIR, "QQQ");
  if (local && local.dates.length > 0) return closesFromPanel(local.dates, local.close);
  return null;
}

export async function loadQqqCloses4h(): Promise<Map<string, number> | null> {
  const local = readCsvPanel(CSV_4H_DIR, "QQQ");
  if (local && local.dates.length > 0) return closesFromPanel(local.dates, local.close);
  return null;
}

export async function loadSpyCloses4h(): Promise<Map<string, number> | null> {
  const local = readCsvPanel(SPY_CSV_DIR, "SPY4H");
  if (local && local.dates.length > 0) return closesFromPanel(local.dates, local.close);

  try {
    const bars = aggregateTo4H(await fetchAlpaca30MBars("SPY", "2021-01-01T00:00:00Z"));
    if (bars.length === 0) return null;
    writeCsvPanel(
      SPY_CSV_DIR,
      "SPY4H",
      bars.map((b) => ({
        date: barTimeISO(b.timestamp),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
    );
    return new Map(bars.map((b) => [barTimeISO(b.timestamp), b.close]));
  } catch {
    return null;
  }
}

export async function loadSpyCloses(): Promise<Map<string, number> | null> {
  const local = readCsvPanel(SPY_CSV_DIR, "SPY");
  if (local && local.dates.length > 0) return closesFromPanel(local.dates, local.close);

  try {
    const bars = await fetchYahooDailyBars("SPY", { years: 20 });
    if (bars.length === 0) return null;
    writeCsvPanel(
      SPY_CSV_DIR,
      "SPY",
      bars.map((b) => ({
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
    );
    return new Map(bars.map((b) => [b.date, b.close]));
  } catch {
    return null;
  }
}

function lastWhere<T>(items: readonly T[], pred: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (pred(items[i])) return items[i];
  }
}

/**
 * 把外部基准买入持有叠到已有账本上（Small Fund=QQQ，其他=SPY）。
 * 净值以窗口首日前一交易日收盘为 1，分年 / YTD 和策略「含首日涨跌」口径一致。
 * 写入字段仍叫 `spy`，避免改引擎类型。
 */
export function overlaySpyCurve(
  book: DayBook[],
  byYear: YearRow[],
  ytd: YearToDate | null,
  closes: Map<string, number>,
): void {
  if (book.length === 0 || closes.size === 0) return;

  let last = 0;
  for (const [date, px] of closes) {
    if (date < book[0].date && px > 0) last = px;
  }
  if (!(last > 0)) last = closes.get(book[0].date) ?? 0;
  if (!(last > 0)) return;

  const base = last;
  for (const d of book) {
    const px = closes.get(d.date);
    if (px != null && px > 0) last = px;
    d.spy = last / base;
  }

  for (const row of byYear) {
    const year = String(row.year);
    const end = lastWhere(book, (d) => d.date.startsWith(year) && d.spy != null);
    const prev = lastWhere(book, (d) => d.date < `${year}-01-01` && d.spy != null);
    if (!end?.spy) continue;
    row.spyPct = (end.spy / (prev?.spy ?? 1) - 1) * 100;
  }

  if (ytd) {
    const end = lastWhere(book, (d) => d.date <= ytd.to && d.spy != null);
    const prev = lastWhere(book, (d) => d.date < ytd.from && d.spy != null);
    if (end?.spy) ytd.spyPct = (end.spy / (prev?.spy ?? 1) - 1) * 100;
  }
}
