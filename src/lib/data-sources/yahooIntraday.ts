/** UTC 墙钟到分钟，可排序，作 4H 面板日期轴。 */
export function barTimeISO(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 16);
}

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

const NY_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

/** 美东分钟数，用来把棒分到 9:30–13:30 / 13:30–16:00。 */
export function nyMinutesOf(unixSeconds: number): number {
  const parts = NY_TIME_FMT.formatToParts(new Date(unixSeconds * 1000));
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour * 60 + minute;
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

/** 按美东交易日每 2 根 1H 合成一根，不跨日。末日不足 2 根也收。 */
export function aggregateTo2H(oneHourBars: IntradayBar[]): IntradayBar[] {
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
    for (let i = 0; i < daysBars.length; i += 2) {
      result.push(mergeBars(daysBars.slice(i, i + 2)));
    }
  }
  return result;
}

const SESSION_SPLIT_MINUTES = 13 * 60 + 30;

/** 某美东交易日的墙钟 → unix，自动选 EST/EDT。 */
export function nyWallClockUnix(day: string, hour: number, minute: number): number {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const edt = Math.floor(Date.parse(`${day}T${hh}:${mm}:00-04:00`) / 1000);
  const est = Math.floor(Date.parse(`${day}T${hh}:${mm}:00-05:00`) / 1000);
  const want = hour * 60 + minute;
  if (nyTradingDate(edt) === day && nyMinutesOf(edt) === want) return edt;
  if (nyTradingDate(est) === day && nyMinutesOf(est) === want) return est;
  return edt;
}

/** 按美东交易日合成 4H：9:30–13:30 → am，13:30–16:00 → pm，不跨日。 */
export function aggregateTo4H(intradayBars: IntradayBar[]): IntradayBar[] {
  const byTradingDay = new Map<string, IntradayBar[]>();
  for (const bar of intradayBars) {
    const day = nyTradingDate(bar.timestamp);
    const list = byTradingDay.get(day);
    if (list) list.push(bar);
    else byTradingDay.set(day, [bar]);
  }

  const result: IntradayBar[] = [];
  for (const day of [...byTradingDay.keys()].sort()) {
    const daysBars = byTradingDay.get(day)!;
    const am = daysBars.filter((b) => nyMinutesOf(b.timestamp) < SESSION_SPLIT_MINUTES);
    const pm = daysBars.filter((b) => nyMinutesOf(b.timestamp) >= SESSION_SPLIT_MINUTES);
    if (am.length >= 1) {
      const bar = mergeBars(am);
      bar.timestamp = nyWallClockUnix(day, 9, 30);
      result.push(bar);
    }
    if (pm.length >= 1) {
      const bar = mergeBars(pm);
      bar.timestamp = nyWallClockUnix(day, 13, 30);
      result.push(bar);
    }
  }
  return result;
}
