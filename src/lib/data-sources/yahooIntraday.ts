export type IntradayBar = {
  timestamp: number; // Unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

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
  };
};

export async function fetchYahoo1HBars(symbol: string): Promise<IntradayBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=730d&interval=1h`;
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; MarketCompass/1.0)" },
    next: { revalidate: 60 * 30 },
  });
  if (!response.ok) throw new Error(`Yahoo 1H ${symbol}: HTTP ${response.status}`);

  const payload = (await response.json()) as YahooChartResponse;
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!quote || timestamps.length === 0) throw new Error(`Yahoo 1H ${symbol}: empty`);

  const bars: IntradayBar[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = quote.close?.[i];
    if (close == null) continue;
    bars.push({
      timestamp: timestamps[i],
      open: quote.open?.[i] ?? close,
      high: quote.high?.[i] ?? close,
      low: quote.low?.[i] ?? close,
      close,
      volume: quote.volume?.[i] ?? 0,
    });
  }
  return bars;
}

const NY_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function nyTradingDate(unixSeconds: number): string {
  return NY_DATE_FMT.format(new Date(unixSeconds * 1000));
}

function mergeBars(chunk: IntradayBar[]): IntradayBar {
  return {
    timestamp: chunk[0].timestamp,
    open: chunk[0].open,
    high: Math.max(...chunk.map((b) => b.high)),
    low: Math.min(...chunk.map((b) => b.low)),
    close: chunk[chunk.length - 1].close,
    volume: chunk.reduce((sum, b) => sum + b.volume, 0),
  };
}

/** 按美东交易日合成 4H：前 4 根 1H → am，剩余 → pm，不跨日。 */
export function aggregateTo4H(oneHourBars: IntradayBar[]): IntradayBar[] {
  const byTradingDay = new Map<string, IntradayBar[]>();
  for (const bar of oneHourBars) {
    const day = nyTradingDate(bar.timestamp);
    const list = byTradingDay.get(day);
    if (list) list.push(bar);
    else byTradingDay.set(day, [bar]);
  }

  const result: IntradayBar[] = [];
  for (const day of [...byTradingDay.keys()].sort()) {
    const daysBars = byTradingDay.get(day)!;
    const am = daysBars.slice(0, 4);
    if (am.length === 4) result.push(mergeBars(am));
    const pm = daysBars.slice(4);
    if (pm.length >= 1) result.push(mergeBars(pm));
  }
  return result;
}
