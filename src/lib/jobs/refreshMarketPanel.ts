import { buildAndStoreRpsScale } from "@/lib/backtest/buildRpsScale";
import { lastSettledNyDate, mergeNewBars, type OhlcvBar } from "@/lib/backtest/mergeBars";
import { packPanel, packTimedPanel, unpackPanel, unpackTimedPanel } from "@/lib/backtest/panel";
import { fetchAlpaca30MBars, hasAlpacaCredentials } from "@/lib/data-sources/alpaca";
import { fetchStooqDailyBars } from "@/lib/data-sources/stooq";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import {
  aggregateTo2H,
  aggregateTo4H,
  barTimeISO,
  fetchYahoo1HBars,
  type IntradayBar,
} from "@/lib/data-sources/yahooIntraday";
import { getPrisma } from "@/lib/db/prisma";

const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? 6);
const TF = ["4h", "2h"] as const;
type HourlyTf = (typeof TF)[number];

export type RefreshSlice = {
  tickers: number;
  updated: number;
  unchanged: number;
  failed: number;
  failures: string[];
  newest: string | null;
};

export type RefreshMarketPanelResult = {
  until: string;
  daily: RefreshSlice;
  tf: Record<HourlyTf, RefreshSlice>;
  scaleTo: string | null;
};

function panelToBars(panel: ReturnType<typeof unpackPanel>): OhlcvBar[] {
  return panel.dates.map((date, i) => ({
    date,
    open: panel.open?.[i] ?? panel.close[i],
    high: panel.high[i],
    low: panel.low[i],
    close: panel.close[i],
    volume: panel.volume?.[i] ?? 0,
  }));
}

function toOhlcv(bars: IntradayBar[]): OhlcvBar[] {
  return bars.map((b) => ({
    date: barTimeISO(b.timestamp),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

function summarize(
  outcomes: { kind: "updated" | "unchanged" | "failed"; last: string; error?: string }[],
): RefreshSlice {
  let updated = 0;
  let unchanged = 0;
  const failures: string[] = [];
  let newest: string | null = null;
  for (const o of outcomes) {
    if (o.kind === "updated") updated += 1;
    else if (o.kind === "unchanged") unchanged += 1;
    else if (o.error) failures.push(o.error);
    if (!newest || o.last > newest) newest = o.last;
  }
  return {
    tickers: outcomes.length,
    updated,
    unchanged,
    failed: failures.length,
    failures: failures.slice(0, 20),
    newest,
  };
}

async function fetchDaily(ticker: string): Promise<OhlcvBar[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchYahooDailyBars(ticker, { years: 1 });
    } catch {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
    }
  }
  const bars = await fetchStooqDailyBars(ticker);
  if (bars.length === 0) throw new Error("Yahoo/Stooq 都空");
  return bars;
}

async function fetchIntraday(ticker: string, fromIso: string): Promise<IntradayBar[]> {
  if (hasAlpacaCredentials()) return fetchAlpaca30MBars(ticker, fromIso);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetchYahoo1HBars(ticker);
    } catch {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
    }
  }
  throw new Error("Yahoo 1H 失败");
}

function aggregateHourly(raw: IntradayBar[], tf: HourlyTf): OhlcvBar[] {
  return toOhlcv(tf === "4h" ? aggregateTo4H(raw) : aggregateTo2H(raw));
}

async function mapPool<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY);
    out.push(...(await Promise.all(batch.map(worker))));
  }
  return out;
}

async function refreshDaily(until: string): Promise<RefreshSlice> {
  const prisma = getPrisma();
  const rows = await prisma.backtestPanel.findMany({
    select: {
      ticker: true,
      lastDate: true,
      days: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      open: true,
    },
    orderBy: { ticker: "asc" },
  });

  return summarize(
    await mapPool(rows, async (row) => {
      const last = row.lastDate.toISOString().slice(0, 10);
      if (last >= until) return { kind: "unchanged" as const, last };
      try {
        const existing = panelToBars(unpackPanel(row));
        const merged = mergeNewBars(existing, await fetchDaily(row.ticker), until);
        const tip = merged[merged.length - 1]!.date;
        if (merged.length === existing.length) return { kind: "unchanged" as const, last: tip };
        const packed = packPanel(merged);
        await prisma.backtestPanel.update({
          where: { ticker: row.ticker },
          data: {
            firstDate: packed.firstDate,
            lastDate: packed.lastDate,
            barCount: packed.barCount,
            days: packed.days,
            high: packed.high,
            low: packed.low,
            close: packed.close,
            volume: packed.volume,
            open: packed.open,
          },
        });
        return { kind: "updated" as const, last: tip };
      } catch (error) {
        return {
          kind: "failed" as const,
          last,
          error: `${row.ticker}: ${error instanceof Error ? error.message : error}`,
        };
      }
    }),
  );
}

async function refreshHourly(until: string): Promise<Record<HourlyTf, RefreshSlice>> {
  const prisma = getPrisma();
  const rows = await prisma.backtestTfPanel.findMany({
    where: { timeframe: { in: [...TF] } },
    select: {
      ticker: true,
      timeframe: true,
      lastDate: true,
      times: true,
      high: true,
      low: true,
      close: true,
      volume: true,
      open: true,
    },
    orderBy: { ticker: "asc" },
  });

  const byTicker = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byTicker.get(row.ticker) ?? [];
    list.push(row);
    byTicker.set(row.ticker, list);
  }

  const outcomes: Record<HourlyTf, { kind: "updated" | "unchanged" | "failed"; last: string; error?: string }[]> = {
    "4h": [],
    "2h": [],
  };

  await mapPool([...byTicker.entries()], async ([ticker, tfs]) => {
    const need = tfs.filter((row) => row.lastDate.toISOString().slice(0, 10) < until);
    if (need.length === 0) {
      for (const row of tfs) {
        outcomes[row.timeframe as HourlyTf].push({
          kind: "unchanged",
          last: row.lastDate.toISOString().slice(0, 16).replace(" ", "T"),
        });
      }
      return;
    }

    const oldest = need.reduce((min, row) => (row.lastDate < min ? row.lastDate : min), need[0]!.lastDate);
    const fromIso = new Date(oldest.getTime() - 2 * 86_400_000).toISOString();

    let raw: IntradayBar[];
    try {
      raw = await fetchIntraday(ticker, fromIso);
    } catch (error) {
      const msg = `${ticker}: ${error instanceof Error ? error.message : error}`;
      for (const row of need) {
        outcomes[row.timeframe as HourlyTf].push({
          kind: "failed",
          last: row.lastDate.toISOString(),
          error: msg,
        });
      }
      for (const row of tfs.filter((r) => !need.includes(r))) {
        outcomes[row.timeframe as HourlyTf].push({
          kind: "unchanged",
          last: row.lastDate.toISOString(),
        });
      }
      return;
    }

    for (const row of tfs) {
      const tf = row.timeframe as HourlyTf;
      const last = row.lastDate.toISOString().slice(0, 10);
      if (last >= until) {
        outcomes[tf].push({ kind: "unchanged", last: row.lastDate.toISOString() });
        continue;
      }
      try {
        const existing = panelToBars(unpackTimedPanel(row));
        const merged = mergeNewBars(existing, aggregateHourly(raw, tf), until);
        const tip = merged[merged.length - 1]!.date;
        if (merged.length === existing.length) {
          outcomes[tf].push({ kind: "unchanged", last: tip });
          continue;
        }
        const packed = packTimedPanel(merged);
        await prisma.backtestTfPanel.update({
          where: { ticker_timeframe: { ticker, timeframe: tf } },
          data: {
            firstDate: packed.firstDate,
            lastDate: packed.lastDate,
            barCount: packed.barCount,
            times: packed.times,
            high: packed.high,
            low: packed.low,
            close: packed.close,
            volume: packed.volume,
            open: packed.open,
          },
        });
        outcomes[tf].push({ kind: "updated", last: tip });
      } catch (error) {
        outcomes[tf].push({
          kind: "failed",
          last,
          error: `${ticker}: ${error instanceof Error ? error.message : error}`,
        });
      }
    }
  });

  return { "4h": summarize(outcomes["4h"]), "2h": summarize(outcomes["2h"]) };
}

/**
 * 给回测面板补到最近一个已收盘日：日线 + 库里的 4H/2H。
 * 1H 不入库（Neon 放不下）。有 Alpaca 走 30 分钟棒，否则 Yahoo 1H 再聚合。
 */
export async function runRefreshMarketPanelJob(): Promise<RefreshMarketPanelResult> {
  const until = lastSettledNyDate();
  const daily = await refreshDaily(until);
  const tf = await refreshHourly(until);

  let scaleTo: string | null = null;
  if (daily.updated > 0) {
    process.env.BACKTEST_PANEL_REFRESH = "1";
    scaleTo = (await buildAndStoreRpsScale()).to;
  }

  return { until, daily, tf, scaleTo };
}
