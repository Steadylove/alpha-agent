import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import {
  aggregateTo4H,
  fetchYahoo1HBars,
  type IntradayBar,
} from "@/lib/data-sources/yahooIntraday";
import { getPrisma } from "@/lib/db/prisma";
import { hasDatabase } from "@/lib/db/remote";
import { simpleMovingAverage } from "@/lib/scoring/indicators";
import { computeExecutionPlan } from "@/lib/scoring/execution";
import type { Playbook } from "@/lib/scoring/rpsPlaybooks";
import type { DailyBar, ExecutionPlan, StockScore } from "@/lib/types/market";

export type ChartInterval = "1d" | "4h" | "1h";

export type ChartBar = {
  /** 日线 YYYY-MM-DD；小时线为 unix seconds */
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sma20: number | null;
  sma50: number | null;
  sma120: number | null;
  sma250: number | null;
};

export type StockChartData = {
  symbol: string;
  interval: ChartInterval;
  bars: ChartBar[];
  execution: ExecutionPlan | null;
  playbook?: Playbook | null;
  /** 最新一根的均线快照，前端画水平辅助线用 */
  latestMas: {
    sma20: number | null;
    sma50: number | null;
    sma120: number | null;
    sma250: number | null;
    close: number | null;
    stackedBullish: boolean; // SMA20>50>120>250
  };
};

function withMas(
  times: Array<string | number>,
  ohlcv: Array<{ open: number; high: number; low: number; close: number; volume: number }>,
): ChartBar[] {
  const closes = ohlcv.map((b) => b.close);
  return ohlcv.map((b, i) => ({
    time: times[i],
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    sma20: simpleMovingAverage(closes.slice(0, i + 1), 20),
    sma50: simpleMovingAverage(closes.slice(0, i + 1), 50),
    sma120: simpleMovingAverage(closes.slice(0, i + 1), 120),
    sma250: simpleMovingAverage(closes.slice(0, i + 1), 250),
  }));
}

function latestMasFrom(bars: ChartBar[]): StockChartData["latestMas"] {
  const last = bars[bars.length - 1];
  if (!last) {
    return {
      sma20: null,
      sma50: null,
      sma120: null,
      sma250: null,
      close: null,
      stackedBullish: false,
    };
  }
  const stackedBullish =
    last.sma20 != null &&
    last.sma50 != null &&
    last.sma120 != null &&
    last.sma250 != null &&
    last.sma20 > last.sma50 &&
    last.sma50 > last.sma120 &&
    last.sma120 > last.sma250;
  return {
    sma20: last.sma20,
    sma50: last.sma50,
    sma120: last.sma120,
    sma250: last.sma250,
    close: last.close,
    stackedBullish,
  };
}

function wrap(
  symbol: string,
  interval: ChartInterval,
  bars: ChartBar[],
  execution: ExecutionPlan | null,
  playbook?: Playbook | null,
): StockChartData {
  return {
    symbol,
    interval,
    bars,
    execution,
    playbook: playbook ?? null,
    latestMas: latestMasFrom(bars),
  };
}

/** 读 DB 里存的日线，附带 SMA，再用最新分数重算 execution plan */
export async function getStockChartData(
  symbol: string,
  stockScore: StockScore | null,
): Promise<StockChartData | null> {
  if (!hasDatabase()) return null;
  const prisma = getPrisma();
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) return null;

  const rows = await prisma.dailyBar.findMany({
    where: { instrumentId: instrument.id },
    orderBy: { date: "asc" },
  });
  if (rows.length === 0) return null;

  const rawBars: DailyBar[] = rows.map((row) => ({
    symbol,
    date: row.date.toISOString().slice(0, 10),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: Number(row.volume),
    source: row.source,
  }));

  const bars = withMas(
    rawBars.map((b) => b.date),
    rawBars,
  );
  const execution = stockScore ? computeExecutionPlan(rawBars, stockScore) : null;
  return wrap(symbol, "1d", bars, execution);
}

function dailyToChart(symbol: string, rawBars: DailyBar[], playbook?: Playbook | null): StockChartData {
  const bars = withMas(
    rawBars.map((b) => b.date),
    rawBars,
  );
  return wrap(symbol, "1d", bars, null, playbook);
}

function intradayToChart(
  symbol: string,
  interval: "1h" | "4h",
  raw: IntradayBar[],
  playbook?: Playbook | null,
): StockChartData {
  const bars = withMas(
    raw.map((b) => b.timestamp),
    raw,
  );
  return wrap(symbol, interval, bars, null, playbook);
}

/**
 * Screener 图表：支持 1d / 4h / 1h。
 * - 1d：DB 优先，不足再 Yahoo daily
 * - 1h/4h：Yahoo 1H，4H 本地按交易日合成
 */
export async function getStockChartDataWithFallback(
  symbol: string,
  options: { interval?: ChartInterval; playbook?: Playbook | null } = {},
): Promise<StockChartData | null> {
  const interval = options.interval ?? "1d";
  const playbook = options.playbook ?? null;

  if (interval === "1d") {
    const fromDb = await getStockChartData(symbol, null).catch(() => null);
    if (fromDb && fromDb.bars.length >= 30) {
      return { ...fromDb, playbook, latestMas: latestMasFrom(fromDb.bars) };
    }
    const yahooBars = await fetchYahooDailyBars(symbol);
    if (yahooBars.length === 0) return null;
    return dailyToChart(symbol, yahooBars, playbook);
  }

  const oneHour = await fetchYahoo1HBars(symbol);
  if (oneHour.length < 30) return null;
  if (interval === "1h") return intradayToChart(symbol, "1h", oneHour, playbook);
  const fourHour = aggregateTo4H(oneHour);
  if (fourHour.length < 30) return null;
  return intradayToChart(symbol, "4h", fourHour, playbook);
}
