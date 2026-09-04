import "dotenv/config";

import { writeFileSync } from "node:fs";
import path from "node:path";

import { alpacaSymbol, BROAD_EXTRA_TICKERS } from "@/lib/backtest/broadUniverse";
import {
  CSV_1H_DIR,
  CSV_2H_DIR,
  CSV_4H_DIR,
  hasCsvPanel,
  readCsvPanel,
  writeCsvPanel,
} from "@/lib/backtest/csvPanel";
import { fetchAlpaca30MBars } from "@/lib/data-sources/alpaca";
import { aggregateTo1H, aggregateTo2H, aggregateTo4H, barTimeISO } from "@/lib/data-sources/yahooIntraday";

/**
 * 扩池日内：每只只拉一次 Alpaca 30Min（2016 起），同时写出 1H / 4H / 2H。
 * 已有三份文件且根数够就跳过，中断后续跑。
 *
 *   ALPACA_FEED=sip npm run broad:fetch-intraday
 */

const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? 4);
const REFETCH = process.env.SMALLFUND_REFETCH === "1";
const MIN_BARS = 253;
const FROM = "2016-01-01T00:00:00Z";
const PROGRESS = path.join(process.cwd(), "data", "broad-intraday-progress.json");

type Outcome = { ticker: string; bars1h?: number; bars4h?: number; first?: string; reason?: string };

function writeBars(
  dir: string,
  ticker: string,
  bars: { timestamp: number; open: number; high: number; low: number; close: number; volume: number }[],
) {
  writeCsvPanel(
    dir,
    ticker,
    bars.map((b) => ({
      date: barTimeISO(b.timestamp),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    })),
  );
}

function alreadyHave(ticker: string): Outcome | null {
  if (REFETCH) return null;
  if (!hasCsvPanel(CSV_1H_DIR, ticker) || !hasCsvPanel(CSV_4H_DIR, ticker) || !hasCsvPanel(CSV_2H_DIR, ticker)) {
    return null;
  }
  const one = readCsvPanel(CSV_1H_DIR, ticker);
  const four = readCsvPanel(CSV_4H_DIR, ticker);
  if (!one || !four || one.dates.length < MIN_BARS || four.dates.length < MIN_BARS) return null;
  return { ticker, bars1h: one.dates.length, bars4h: four.dates.length, first: one.dates[0] };
}

async function fetchOne(ticker: string): Promise<Outcome> {
  const cached = alreadyHave(ticker);
  if (cached) return cached;

  try {
    const raw = await fetchAlpaca30MBars(alpacaSymbol(ticker), FROM);
    const hourly = aggregateTo1H(raw);
    const four = aggregateTo4H(raw);
    if (hourly.length < MIN_BARS) throw new Error(`1H 样本不足 ${hourly.length} 根`);
    if (four.length < MIN_BARS) throw new Error(`4H 样本不足 ${four.length} 根`);

    writeBars(CSV_1H_DIR, ticker, hourly);
    writeBars(CSV_4H_DIR, ticker, four);

    const two = aggregateTo2H(hourly);
    if (two.length < MIN_BARS) throw new Error(`2H 样本不足 ${two.length} 根`);
    writeBars(CSV_2H_DIR, ticker, two);

    return {
      ticker,
      bars1h: hourly.length,
      bars4h: four.length,
      first: barTimeISO(hourly[0].timestamp),
    };
  } catch (error) {
    return { ticker, reason: error instanceof Error ? error.message : "抓取失败" };
  }
}

async function main() {
  const tickers = [...BROAD_EXTRA_TICKERS];
  console.log(
    `扩池日内  30Min→1H/2H/4H  ${tickers.length} 只  并发 ${CONCURRENCY}` +
      `${REFETCH ? "  [强制重抓]" : ""}  feed=${process.env.ALPACA_FEED ?? "auto"}`,
  );

  const ok: Outcome[] = [];
  const failed: Outcome[] = [];
  let done = 0;

  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    for (const r of await Promise.all(batch.map(fetchOne))) {
      if (r.bars1h) ok.push(r);
      else failed.push(r);
    }
    done += batch.length;
    writeFileSync(
      PROGRESS,
      JSON.stringify({ done, total: tickers.length, ok: ok.length, failed: failed.length, last: ok.at(-1), errors: failed }, null, 2),
    );
    const hint = failed[0]?.reason ? `  例 ${failed[0].ticker}:${failed[0].reason.slice(0, 70)}` : "";
    process.stdout.write(`\r进度 ${done}/${tickers.length}  成功 ${ok.length}  失败 ${failed.length}${hint}   `);
  }

  console.log(`\n\n拿到 ${ok.length} 只  失败 ${failed.length}`);
  if (failed.length > 0) {
    console.log("\n失败:");
    for (const f of failed) console.log(`  ${f.ticker.padEnd(8)} ${f.reason}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
