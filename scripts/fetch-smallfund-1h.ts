import "dotenv/config";

import {
  CSV_1H_DIR,
  hasCsvPanel,
  listCsvTickers,
  readCsvPanel,
  writeCsvPanel,
} from "@/lib/backtest/csvPanel";
import { SMALL_FUND_EXCLUDED, SMALL_FUND_UNIVERSE } from "@/lib/backtest/smallFundUniverse";
import { fetchAlpaca30MBars } from "@/lib/data-sources/alpaca";
import { aggregateTo1H, barTimeISO, type IntradayBar } from "@/lib/data-sources/yahooIntraday";

/**
 * Small Fund 1H：Alpaca 30 分钟棒聚合成 1H 落盘，与 4H 同一条链路。
 *
 * 不能用 Alpaca 的 `1Hour`：它按整点分桶，承载 9:30–10:00 开盘交易的那根时间戳是
 * 9:00，被 `isNyRegularHours` 当成盘前丢掉，每天少掉开盘后成交最密集的半小时
 * （实测 AAPL 2023-06-15 少 9.38M 股，占全天 21%）。30 分钟棒的时间戳正好落在
 * 9:30，不会被误杀——4H 一直没这个问题就是因为它走的是 30M。
 *
 *   npm run smallfund:fetch-1h
 */

const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? 4);
const REFETCH = process.env.SMALLFUND_REFETCH === "1";
const MIN_BARS = 253;
// 2020-01 起：676 根慢线（与其他周期同根数）需约 2000 根预热，1H 每天 6 根，
// 2000 根只要 333 个交易日；2020-01 到窗口起点 2021-08 有约 2400 根，充分收敛。
// 数据从 2021-01 起时窗口起点只有 966 根、种子残留 42%，此前 1H 的负收益结论是在
// 那份数据上测的，不可信——这才是要补数据的原因。
//
// 不抓到 2016：1H 单只 16000+ 根是 4H 的 3 倍，全量要 8.6 小时（实测无 429，纯数据量）。
// 那多出来的历史只对「把慢线拉到 4056 根、与日线同日历跨度」有用，而那个方案先天
// 不足——4056 根完全收敛需约 12168 根，Alpaca 1H 最早到 2016 也只有 8400 根，
// 种子仍残留 12%。要测它得单独再补。
const FROM = "2016-01-01T00:00:00Z";
// 与 4H 同一套判据：看历史起点而不是文件在不在，否则短历史文件会被当成已完成跳过，
// 而全量重抓又让每次中断都得从头再来。宽限一个月，IPO 更晚的票起点就是上市日。
const HISTORY_OK_BEFORE = "2016-02-01";

type Outcome = { ticker: string; bars?: number; first?: string; reason?: string };

function writeHourly(ticker: string, bars: IntradayBar[]) {
  writeCsvPanel(
    CSV_1H_DIR,
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

function historyGoodEnough(ticker: string): Outcome | null {
  if (!hasCsvPanel(CSV_1H_DIR, ticker)) return null;
  const existing = readCsvPanel(CSV_1H_DIR, ticker);
  if (!existing?.dates.length) return null;
  const first = existing.dates[0];
  if (first >= HISTORY_OK_BEFORE) return null;
  // 旧口径（直抓 1Hour）的时间戳全落在整点，新口径从 9:30 起算必然出现 :30。
  // 只看起点会把缺了开盘半小时的旧文件当成已完成跳过。
  if (!existing.dates.slice(0, 50).some((d) => d.endsWith(":30"))) return null;
  return { ticker, bars: existing.dates.length, first };
}

async function fetchOne(ticker: string): Promise<Outcome> {
  if (!REFETCH) {
    const cached = historyGoodEnough(ticker);
    if (cached) return cached;
  }
  try {
    const bars = aggregateTo1H(await fetchAlpaca30MBars(ticker, FROM));
    if (bars.length < MIN_BARS) throw new Error(`样本不足 ${bars.length} 根`);
    writeHourly(ticker, bars);
    return { ticker, bars: bars.length, first: barTimeISO(bars[0].timestamp) };
  } catch (error) {
    return { ticker, reason: error instanceof Error ? error.message : "抓取失败" };
  }
}

async function main() {
  console.log(
    `Small Fund 1H  Alpaca  ${SMALL_FUND_UNIVERSE.length} 只  并发 ${CONCURRENCY}` +
      `${REFETCH ? "  [强制重抓]" : ""}`,
  );
  for (const { symbol, reason } of SMALL_FUND_EXCLUDED) {
    console.log(`  剔除 ${symbol}  ${reason}`);
  }
  console.log(`输出 ${CSV_1H_DIR}\n`);

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

  console.log(`\n\n拿到 ${ok.length} 只  目录内 ${listCsvTickers(CSV_1H_DIR).length} 个文件`);
  if (failed.length > 0) {
    console.log(`\n失败 ${failed.length} 只:`);
    for (const f of failed) console.log(`  ${f.ticker.padEnd(8)} ${f.reason}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
