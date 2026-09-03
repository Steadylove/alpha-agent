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

type Slot = { hour: number; minute: number };

/**
 * 2H 的三个桶，按美东墙钟切：9:30–11:30、11:30–13:30、13:30 之后（含盘后，2.5 小时）。
 * 首桶同时收下盘前，与 `aggregateTo4H` 一致，避免丢 bar。
 */
const TWO_HOUR_SLOTS: readonly Slot[] = [
  { hour: 9, minute: 30 },
  { hour: 11, minute: 30 },
  { hour: 13, minute: 30 },
];

/**
 * 1H 的七个桶，从开盘起每小时切一刀，末桶 15:30 之后只有半小时。
 *
 * 切点必须从 9:30 起算而不是整点，这样 11:30 / 13:30 同时是 2H 与 4H 的桶边界，
 * 三个周期的 bar 完美嵌套：同一时刻在哪个周期上看，边界都对得齐。
 */
const ONE_HOUR_SLOTS: readonly Slot[] = [
  { hour: 9, minute: 30 },
  { hour: 10, minute: 30 },
  { hour: 11, minute: 30 },
  { hour: 12, minute: 30 },
  { hour: 13, minute: 30 },
  { hour: 14, minute: 30 },
  { hour: 15, minute: 30 },
];

/**
 * 按美东墙钟的固定切点分桶合成，不跨交易日。首桶下界开放（收下盘前），末桶上界开放。
 *
 * 必须按墙钟绝对分桶，不能按「每 N 根配一根」：某只票某天开盘那根没成交时，相对配对
 * 会让它当天之后所有 bar 整体错开一格，跨票时间戳对不上，横截面比较（RPS 门槛、同时刻
 * 决策）随之失真；每天根数也会随票浮动，年化基数跟着错。
 */
function aggregateBySlots(bars: IntradayBar[], slots: readonly Slot[]): IntradayBar[] {
  const byTradingDay = new Map<string, IntradayBar[]>();
  for (const bar of bars) {
    const day = nyTradingDate(bar.timestamp);
    const list = byTradingDay.get(day);
    if (list) list.push(bar);
    else byTradingDay.set(day, [bar]);
  }

  const result: IntradayBar[] = [];
  for (const day of [...byTradingDay.keys()].sort()) {
    const daysBars = byTradingDay.get(day)!;
    for (const [i, slot] of slots.entries()) {
      const next = slots[i + 1];
      const upper = next == null ? Infinity : next.hour * 60 + next.minute;
      const lower = i === 0 ? -Infinity : slot.hour * 60 + slot.minute;
      const inSlot = daysBars.filter((b) => {
        const m = nyMinutesOf(b.timestamp);
        return m >= lower && m < upper;
      });
      if (inSlot.length === 0) continue;
      const merged = mergeBars(inSlot);
      merged.timestamp = nyWallClockUnix(day, slot.hour, slot.minute);
      result.push(merged);
    }
  }
  return result;
}

/**
 * 按美东交易日合成 1H。
 *
 * 输入应为 30 分钟棒，不要用 Alpaca 的 `1Hour`：它按整点分桶，承载 9:30–10:00 开盘
 * 交易的那根时间戳是 9:00，会被 `isNyRegularHours` 当成盘前丢掉，每天少掉开盘后
 * 成交最密集的半小时。
 */
export function aggregateTo1H(intradayBars: IntradayBar[]): IntradayBar[] {
  return aggregateBySlots(intradayBars, ONE_HOUR_SLOTS);
}

/** 按美东交易日合成 2H。输入可以是 30 分钟棒，也可以是本函数口径下的 1H 棒。 */
export function aggregateTo2H(intradayBars: IntradayBar[]): IntradayBar[] {
  return aggregateBySlots(intradayBars, TWO_HOUR_SLOTS);
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
