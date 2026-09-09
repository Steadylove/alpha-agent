import { DEFAULT_BACKTEST_CONFIG, type PreparedSymbol, type PreparedUniverse } from "@/lib/backtest/engine";
import type { RotateOpts } from "@/lib/fund/rotate";

export const axis = Array.from({ length: 80 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i, 14, 30)).toISOString().slice(0, 16));
export function symbol(ticker: string, signals = [35], closes = Array.from({ length: 80 }, (_, i) => i < 37 ? 100 : 100 + (i - 36) * 0.1), count = 80): PreparedSymbol {
  const prices = closes.slice(0, count);
  return {
    ticker, axisIndex: Int32Array.from(prices.map((_, i) => i)),
    high: Float32Array.from(prices.map((p) => p + 2)), low: Float32Array.from(prices.map((p) => p - 2)),
    close: Float32Array.from(prices), open: Float32Array.from(prices),
    buy1: Uint8Array.from(prices.map((_, i) => Number(signals.includes(i)))), buy2: new Uint8Array(count),
    rps: new Float32Array(count).fill(80), isMember: new Uint8Array(count).fill(1),
    adtv50: new Float32Array(count).fill(1e9), aboveTrend: new Uint8Array(count).fill(1),
    rsi14: new Float32Array(count).fill(70), vegasOk: new Uint8Array(count).fill(1),
  };
}
export const universe = (...symbols: PreparedSymbol[]): PreparedUniverse => ({ axis, symbols });
export const config = { ...DEFAULT_BACKTEST_CONFIG, from: axis[30], to: axis[79], timeframe: "4h" as const,
  minPrice: 0, minAdtvUsd: 0, requireVegas: false, requireRsi: false, requireTrend: false,
  useBuy1: true, useBuy2: true, rpsMin: 0, rpsExit: null, takeProfitR: null, stopMult: 4, trailMult: 6 };
export const options: RotateOpts = { slotPct: 0.1, costBps: 10, mode: "none", edge: 0, retainMissing: true, continuation: { capture: true } };
