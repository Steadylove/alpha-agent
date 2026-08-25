import "dotenv/config";

import {
  CSV_4H_DIR,
  hasCsvPanel,
  listCsvTickers,
  readCsvPanel,
  writeCsvPanel,
} from "@/lib/backtest/csvPanel";
import { SMALL_FUND_EXCLUDED, SMALL_FUND_UNIVERSE } from "@/lib/backtest/smallFundUniverse";
import { SPY_CSV_DIR } from "@/lib/backtest/spyCurve";
import { fetchAlpaca30MBars } from "@/lib/data-sources/alpaca";
import { aggregateTo4H, barTimeISO } from "@/lib/data-sources/yahooIntraday";

/**
 * Small Fund 4H：Alpaca 30Min（从 2021）按 9:30–13:30 / 13:30–16:00 合成。
 *
 *   npm run smallfund:fetch-4h
 *   SMALLFUND_REFETCH=1 npm run smallfund:fetch-4h
 */

const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? 4);
const REFETCH = process.env.SMALLFUND_REFETCH === "1";
const MIN_BARS = 253;
const FROM = "2021-01-01T00:00:00Z";

type Outcome = { ticker: string; bars?: number; first?: string; reason?: string };

function writeFourHour(dir: string, ticker: string, four: ReturnType<typeof aggregateTo4H>) {
  writeCsvPanel(
    dir,
    ticker,
    four.map((b) => ({
      date: barTimeISO(b.timestamp),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    })),
  );
}

async function fetchFourHour(ticker: string) {
  const four = aggregateTo4H(await fetchAlpaca30MBars(ticker, FROM));
  if (four.length < MIN_BARS) throw new Error(`样本不足 ${four.length} 根`);
  return four;
}

async function fetchOne(ticker: string): Promise<Outcome> {
  if (!REFETCH && hasCsvPanel(CSV_4H_DIR, ticker)) {
    const existing = readCsvPanel(CSV_4H_DIR, ticker);
    if (existing) return { ticker, bars: existing.dates.length, first: existing.dates[0] };
  }
  try {
    const four = await fetchFourHour(ticker);
    writeFourHour(CSV_4H_DIR, ticker, four);
    return { ticker, bars: four.length, first: barTimeISO(four[0].timestamp) };
  } catch (error) {
    return { ticker, reason: error instanceof Error ? error.message : "抓取失败" };
  }
}

async function main() {
  console.log(
    `Small Fund 4H  Alpaca 30Min→9:30/13:30  ${SMALL_FUND_UNIVERSE.length} 只  并发 ${CONCURRENCY}` +
      `${REFETCH ? "  [强制重抓]" : ""}`,
  );
  for (const { symbol, reason } of SMALL_FUND_EXCLUDED) {
    console.log(`  剔除 ${symbol}  ${reason}`);
  }
  console.log(`输出 ${CSV_4H_DIR}\n`);

  const ok: Outcome[] = [];
  const failed: Outcome[] = [];
  let done = 0;

  for (let i = 0; i < SMALL_FUND_UNIVERSE.length; i += CONCURRENCY) {
    const batch = SMALL_FUND_UNIVERSE.slice(i, i + CONCURRENCY);
    for (const r of await Promise.all(batch.map(fetchOne))) {
      if (r.bars) ok.push(r);
      else failed.push(r);
    }
    done += batch.length;
    const hint = failed[0]?.reason ? `  例 ${failed[0].ticker}:${failed[0].reason.slice(0, 60)}` : "";
    process.stdout.write(
      `\r进度 ${done}/${SMALL_FUND_UNIVERSE.length}  成功 ${ok.length}  失败 ${failed.length}${hint}   `,
    );
  }

  try {
    const four = await fetchFourHour("SPY");
    writeFourHour(SPY_CSV_DIR, "SPY4H", four);
    ok.push({ ticker: "SPY4H", bars: four.length, first: barTimeISO(four[0].timestamp) });
  } catch (error) {
    failed.push({
      ticker: "SPY4H",
      reason: error instanceof Error ? error.message : "抓取失败",
    });
  }

  console.log(`\n\n拿到 ${ok.length} 只  目录内 ${listCsvTickers(CSV_4H_DIR).length} 个文件`);
  if (failed.length > 0) {
    console.log(`\n失败 ${failed.length} 只:`);
    for (const f of failed) console.log(`  ${f.ticker.padEnd(8)} ${f.reason}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
