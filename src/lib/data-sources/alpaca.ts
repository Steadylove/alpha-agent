import type { IntradayBar } from "@/lib/data-sources/yahooIntraday";
import type { DailyBar } from "@/lib/types/market";

const DATA_URL = "https://data.alpaca.markets/v2/stocks";
const FEEDS = ["sip", "iex"] as const;

type AlpacaFeed = (typeof FEEDS)[number];
type AlpacaTimeframe = "1Hour" | "30Min" | "1Day";

type AlpacaBar = {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

type AlpacaBarsResponse = {
  bars?: AlpacaBar[];
  next_page_token?: string | null;
};

let resolvedFeed: AlpacaFeed | null = null;

export function alpacaCredentials(): { key: string; secret: string } {
  const key = process.env.ALPACA_API_KEY ?? process.env.APCA_API_KEY_ID ?? "";
  const secret = process.env.ALPACA_API_SECRET ?? process.env.APCA_API_SECRET_KEY ?? "";
  if (!key || !secret) throw new Error("缺少 ALPACA_API_KEY / ALPACA_API_SECRET");
  return { key, secret };
}

/** 美东常规时段 09:30–16:00，排除盘前盘后，避免打乱 4H 上/下午合成。 */
export function isNyRegularHours(unixSeconds: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(unixSeconds * 1000));
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

function endIso(): string {
  return new Date(Date.now() - 20 * 60 * 1000).toISOString();
}

function toBar(row: AlpacaBar): IntradayBar | null {
  if (!Number.isFinite(row.c)) return null;
  const timestamp = Math.floor(new Date(row.t).getTime() / 1000);
  if (!Number.isFinite(timestamp) || !isNyRegularHours(timestamp)) return null;
  return {
    timestamp,
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    volume: row.v,
  };
}

const PAGE_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 6;
const MAX_INFLIGHT = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let inflight = 0;
const queue: Array<() => void> = [];

async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
  while (inflight >= MAX_INFLIGHT) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  inflight += 1;
  try {
    return await fn();
  } finally {
    inflight -= 1;
    queue.shift()?.();
  }
}

async function fetchPage(
  symbol: string,
  feed: AlpacaFeed,
  from: string,
  to: string,
  pageToken: string | null,
  timeframe: AlpacaTimeframe,
): Promise<AlpacaBarsResponse> {
  const { key, secret } = alpacaCredentials();
  const url = new URL(`${DATA_URL}/${encodeURIComponent(symbol)}/bars`);
  url.searchParams.set("timeframe", timeframe);
  url.searchParams.set("start", from);
  url.searchParams.set("end", to);
  url.searchParams.set("limit", "10000");
  url.searchParams.set("adjustment", "all");
  url.searchParams.set("feed", feed);
  url.searchParams.set("sort", "asc");
  if (pageToken) url.searchParams.set("page_token", pageToken);

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await withLimit(() => fetch(url, {
        headers: {
          "APCA-API-KEY-ID": key,
          "APCA-API-SECRET-KEY": secret,
        },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      }));
      if (response.status === 429 || response.status >= 500) {
        await sleep(2_000 * 2 ** attempt);
        lastError = new Error(`Alpaca ${timeframe} ${symbol} ${feed}: HTTP ${response.status}`);
        continue;
      }
      if (!response.ok) {
        const body = await response.text();
        if (response.status === 401) {
          throw new Error("Alpaca 401：检查 ALPACA_API_KEY / ALPACA_API_SECRET");
        }
        throw new Error(`Alpaca ${timeframe} ${symbol} ${feed}: HTTP ${response.status} ${body.slice(0, 160)}`);
      }
      return (await response.json()) as AlpacaBarsResponse;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.name === "TimeoutError") {
        await sleep(1_000 * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Alpaca ${timeframe} ${symbol} ${feed}: 请求失败`);
}

async function fetchAllPages(
  symbol: string,
  feed: AlpacaFeed,
  from: string,
  to: string,
  timeframe: AlpacaTimeframe,
): Promise<AlpacaBar[]> {
  const bars: AlpacaBar[] = [];
  let token: string | null = null;
  do {
    const page = await fetchPage(symbol, feed, from, to, token, timeframe);
    bars.push(...(page.bars ?? []));
    token = page.next_page_token ?? null;
  } while (token);
  return bars;
}

function yearChunks(from: string, to: string): [string, string][] {
  const end = new Date(to);
  const chunks: [string, string][] = [];
  let cursor = new Date(from);
  while (cursor < end) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear() + 1, 0, 1));
    const chunkEnd = next < end ? next : end;
    chunks.push([cursor.toISOString(), chunkEnd.toISOString()]);
    cursor = chunkEnd;
  }
  return chunks;
}

async function fetchBars(
  symbol: string,
  feed: AlpacaFeed,
  from: string,
  timeframe: AlpacaTimeframe,
): Promise<AlpacaBar[]> {
  const to = endIso();
  if (timeframe === "1Day") return fetchAllPages(symbol, feed, from, to, timeframe);
  const parts = await Promise.all(
    yearChunks(from, to).map(([start, stop]) => fetchAllPages(symbol, feed, start, stop, timeframe)),
  );
  const seen = new Set<string>();
  const out: AlpacaBar[] = [];
  for (const row of parts.flat()) {
    if (seen.has(row.t)) continue;
    seen.add(row.t);
    out.push(row);
  }
  return out;
}

function shouldTryNextFeed(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : "";
  return (
    /HTTP 403/.test(msg) ||
    /HTTP 429/.test(msg) ||
    /invalid feed/i.test(msg) ||
    /subscription/i.test(msg) ||
    /请求失败/.test(msg) ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

async function fetchAlpacaIntraday(
  symbol: string,
  from: string,
  timeframe: Exclude<AlpacaTimeframe, "1Day">,
  label: string,
): Promise<IntradayBar[]> {
  const feeds: AlpacaFeed[] = resolvedFeed ? [resolvedFeed] : [...FEEDS];
  let lastError: unknown;
  for (const feed of feeds) {
    try {
      const bars = await fetchBars(symbol, feed, from, timeframe);
      resolvedFeed = feed;
      return bars.map(toBar).filter((bar): bar is IntradayBar => bar != null);
    } catch (error) {
      lastError = error;
      if (!shouldTryNextFeed(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Alpaca ${label} ${symbol}: 无可用 feed`);
}

export async function fetchAlpaca1HBars(
  symbol: string,
  from = "2021-01-01T00:00:00Z",
): Promise<IntradayBar[]> {
  return fetchAlpacaIntraday(symbol, from, "1Hour", "1H");
}

/** 常规时段 30 分钟棒，用来按 9:30–13:30 / 13:30–16:00 合成 4H。 */
export async function fetchAlpaca30MBars(
  symbol: string,
  from = "2021-01-01T00:00:00Z",
): Promise<IntradayBar[]> {
  return fetchAlpacaIntraday(symbol, from, "30Min", "30M");
}

function nyDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
}

export async function fetchAlpacaDailyBars(
  symbol: string,
  from = "2013-01-01T00:00:00Z",
): Promise<DailyBar[]> {
  const feeds: AlpacaFeed[] = resolvedFeed ? [resolvedFeed] : [...FEEDS];
  let lastError: unknown;
  for (const feed of feeds) {
    try {
      const rows = await fetchBars(symbol, feed, from, "1Day");
      resolvedFeed = feed;
      return rows
        .filter((row) => Number.isFinite(row.c))
        .map((row) => ({
          symbol,
          date: nyDate(row.t),
          open: row.o,
          high: row.h,
          low: row.l,
          close: row.c,
          volume: row.v,
          source: "alpaca",
        }));
    } catch (error) {
      lastError = error;
      if (!shouldTryNextFeed(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Alpaca 1D ${symbol}: 无可用 feed`);
}
