import { loadMarketPanel } from "@/lib/backtest/marketRemote";

export type DailyBarRow = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export async function loadDailyBars(symbols: readonly string[]): Promise<Map<string, DailyBarRow[]>> {
  const bySymbol = new Map<string, DailyBarRow[]>();
  for (const symbol of symbols) {
    const panel = await loadMarketPanel("1d", symbol);
    if (!panel || panel.dates.length === 0) continue;
    bySymbol.set(
      symbol,
      panel.dates.map((date, i) => ({
        date: date.slice(0, 10),
        open: panel.open?.[i] ?? panel.close[i],
        high: panel.high[i],
        low: panel.low[i],
        close: panel.close[i],
        volume: panel.volume?.[i] ?? 0,
      })),
    );
  }
  return bySymbol;
}
