import path from "node:path";

import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";

import { readCsvPanel, writeCsvPanel } from "./csvPanel";
import type { DayBook, YearRow, YearToDate } from "./engine";

export const SPY_CSV_DIR = path.join(process.cwd(), "data", "benchmarks");

function closesFromPanel(dates: string[], close: Float32Array): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < dates.length; i += 1) {
    if (close[i] > 0) m.set(dates[i], close[i]);
  }
  return m;
}

let cached: Promise<Map<string, number> | null> | null = null;

/** 进程内只拉一次。本地 CSV 优先，没有再问 Yahoo 并落盘。 */
export function getSpyCloses(): Promise<Map<string, number> | null> {
  cached ??= loadSpyCloses().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
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

/**
 * 把 SPY 买入持有叠到已有账本上。净值以窗口首日前一交易日收盘为 1，
 * 这样分年 / YTD 和策略用的「含首日涨跌」口径一致。
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
    const end = book.findLast((d) => d.date.startsWith(year) && d.spy != null);
    const prev = book.findLast((d) => d.date < `${year}-01-01` && d.spy != null);
    if (!end?.spy) continue;
    row.spyPct = (end.spy / (prev?.spy ?? 1) - 1) * 100;
  }

  if (ytd) {
    const end = book.findLast((d) => d.date <= ytd.to && d.spy != null);
    const prev = book.findLast((d) => d.date < ytd.from && d.spy != null);
    if (end?.spy) ytd.spyPct = (end.spy / (prev?.spy ?? 1) - 1) * 100;
  }
}
