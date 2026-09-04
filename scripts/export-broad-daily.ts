import { CSV_PANEL_DIR, hasCsvPanel, writeCsvPanel } from "@/lib/backtest/csvPanel";
import { PANEL_CACHE_PATH, readSnapshot } from "@/lib/backtest/panelCache";
import { unpackPanel } from "@/lib/backtest/panel";
import { BROAD_EXTRA_TICKERS } from "@/lib/backtest/broadUniverse";

/**
 * 把现任标普 ∪ 纳指里尚未落盘的日线，从 panel cache 写出到 data/smallfund/。
 * 不打 Yahoo：这 365 只已经在 .cache/backtest-panel.v8 里。
 *
 *   npx --yes tsx scripts/export-broad-daily.ts
 */

function main() {
  const snap = readSnapshot(PANEL_CACHE_PATH);
  if (!snap) throw new Error(`没有面板缓存 ${PANEL_CACHE_PATH}`);

  const byTicker = new Map(snap.panels.map((row) => [row.ticker, row]));
  let wrote = 0;
  let skipped = 0;
  const missing: string[] = [];

  for (const ticker of BROAD_EXTRA_TICKERS) {
    if (hasCsvPanel(CSV_PANEL_DIR, ticker)) {
      skipped += 1;
      continue;
    }
    const row = byTicker.get(ticker);
    if (!row) {
      missing.push(ticker);
      continue;
    }
    const panel = unpackPanel(row);
    const n = panel.dates.length;
    const bars = [];
    for (let i = 0; i < n; i += 1) {
      bars.push({
        date: panel.dates[i],
        open: panel.open?.[i] ?? panel.close[i],
        high: panel.high[i],
        low: panel.low[i],
        close: panel.close[i],
        volume: panel.volume?.[i] ?? 0,
      });
    }
    writeCsvPanel(CSV_PANEL_DIR, ticker, bars);
    wrote += 1;
  }

  console.log(`日线  写出 ${wrote}  已有跳过 ${skipped}  缓存缺面板 ${missing.length}`);
  if (missing.length > 0) console.log(`缺面板: ${missing.join(" ")}`);
}

main();
