import type { DailyBar } from "@/lib/types/market";

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
    error?: { description?: string };
  };
};

export async function fetchYahooDailyBars(symbol: string): Promise<DailyBar[]> {
  const period2 = Math.floor(Date.now() / 1000);
  // 拉 8 年 ≈ 2000 交易日：EMA676 至少能递推 ~1300 步稳态收敛（3 年 750 根仅 74 步递推，
  // 种子 SMA 还未平滑，会让 EMA676 值虚低影响 Vegas 判断）。
  // daily-report 只吃最近 250 根，扩窗零副作用。
  const period1 = period2 - 8 * 365 * 24 * 60 * 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`;
  const response = await fetch(url, { next: { revalidate: 60 * 60 } });

  if (!response.ok) {
    throw new Error(`Yahoo request failed for ${symbol}: ${response.status}`);
  }

  const payload = (await response.json()) as YahooChartResponse;
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];

  if (!quote || timestamps.length === 0) {
    throw new Error(payload.chart?.error?.description ?? `Yahoo returned no bars for ${symbol}`);
  }

  return timestamps
    .map((timestamp, index) => {
      const close = quote.close?.[index];

      if (close == null) {
        return null;
      }

      return {
        symbol,
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        open: quote.open?.[index] ?? close,
        high: quote.high?.[index] ?? close,
        low: quote.low?.[index] ?? close,
        close,
        volume: quote.volume?.[index] ?? 0,
        source: "yahoo",
      } satisfies DailyBar;
    })
    .filter((bar): bar is DailyBar => bar !== null);
}
