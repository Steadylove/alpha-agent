/**
 * 打印一只 CSV 标的最近 N 根的 OHLC / RSI14 / SMA(RSI,14) / ATR14 / RS，
 * 方便和 TradingView 数据窗口逐根对。
 */
import { readCsvPanel, CSV_PANEL_DIR } from "@/lib/backtest/csvPanel";
import { rotationRsSeries } from "@/lib/scoring/rotationRs";
import { atrSeries, emaSeries, rsiSeries, smaOfNullable } from "@/lib/scoring/series";

const ticker = process.argv[2] ?? "QQQ";
const n = Number(process.argv[3] ?? 8);

const panel = readCsvPanel(CSV_PANEL_DIR, ticker);
if (!panel) throw new Error(`没有 ${ticker}.csv`);

const closes = Array.from(panel.close);
const bars = panel.dates.map((date, i) => ({
  date,
  open: panel.open![i],
  high: panel.high[i],
  low: panel.low[i],
  close: panel.close[i],
}));

const rsi = rsiSeries(closes, 14);
const rsiSma = smaOfNullable(rsi, 14);
const atr = atrSeries(bars, 14);
const atrSma = smaOfNullable(atr, 14);
const ema12 = emaSeries(closes, 12);
const ema26 = emaSeries(closes, 26);
const ema166 = emaSeries(closes, 166);
const ema169 = emaSeries(closes, 169);
const ema576 = emaSeries(closes, 576);
const ema676 = emaSeries(closes, 676);
const rs = rotationRsSeries(closes);

const start = Math.max(0, bars.length - n);
console.log(
  `${ticker}  Yahoo/CSV 共 ${bars.length} 根  ${bars[0].date} → ${bars[bars.length - 1].date}`,
);
console.log(
  "date        o        h        l        c      rsi14  rsiSma14   atr14  atrSma14     ema12     ema26      rs",
);
for (let i = start; i < bars.length; i += 1) {
  const b = bars[i];
  const f = (v: number | null | undefined, d = 2) =>
    v == null || !Number.isFinite(v) ? "     n/a" : v.toFixed(d).padStart(8);
  console.log(
    `${b.date} ${f(b.open)} ${f(b.high)} ${f(b.low)} ${f(b.close)} ${f(rsi[i])} ${f(rsiSma[i])} ${f(atr[i])} ${f(atrSma[i])} ${f(ema12[i])} ${f(ema26[i])} ${f(rs[i], 1)}`,
  );
}

const last = bars.length - 1;
console.log("\nVegas 末根:");
console.log(
  `  EMA166=${ema166[last]?.toFixed(4)}  EMA169=${ema169[last]?.toFixed(4)}  EMA576=${ema576[last]?.toFixed(4)}  EMA676=${ema676[last]?.toFixed(4)}`,
);
const vegasOk =
  ema166[last] != null &&
  ema169[last] != null &&
  ema576[last] != null &&
  ema676[last] != null &&
  Math.min(ema166[last]!, ema169[last]!) > Math.max(ema576[last]!, ema676[last]!);
console.log(`  vegasOk=${vegasOk}`);
