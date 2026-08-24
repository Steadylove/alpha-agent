import "dotenv/config";

import {
  CSV_PANEL_DIR,
  hasCsvPanel,
  listCsvTickers,
  readCsvPanel,
  writeCsvPanel,
} from "@/lib/backtest/csvPanel";
import {
  SMALL_FUND_EXCLUDED,
  SMALL_FUND_HISTORY_YEARS,
  SMALL_FUND_UNIVERSE,
  SMALL_FUND_WINDOW_YEARS,
} from "@/lib/backtest/smallFundUniverse";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";

/**
 * 把 Small Fund 池的日线抓成 CSV，全程不碰数据库。
 *
 * 数据库额度耗尽期间这是唯一可用的路径；额度恢复后用 import-smallfund-to-db.ts
 * 把同一批 CSV 导进 BacktestPanel，两条路径产出的面板逐位相同。
 *
 * 用法:
 *   npx tsx scripts/fetch-smallfund-csv.ts
 *   BACKFILL_CONCURRENCY=3 npx tsx scripts/fetch-smallfund-csv.ts   # Yahoo 限流时降并发
 *   SMALLFUND_REFETCH=1 npx tsx scripts/fetch-smallfund-csv.ts      # 忽略已有文件重抓
 *
 * 续跑不需要额外机制：一只一个文件，已存在的直接跳过。
 */

const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? 6);
const REFETCH = process.env.SMALLFUND_REFETCH === "1";

/**
 * 少于 253 根的标的**provably** 永远不可交易：截面 RPS 要 252 根回看，
 * 253 根才够产出第一个可排名日。抓下来也只是占位，直接判失败。
 */
const MIN_BARS = 253;

const DAY_MS = 86_400_000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

/** 回测窗口起点，用于判断各标的的预热是否覆盖窗口全程。 */
const WINDOW_START = isoDaysAgo(SMALL_FUND_WINDOW_YEARS * 365);
/** 起点当天要能算出截面 RPS，首根须早于此（252 根 ≈ 366 自然日）。 */
const RPS_READY_BY = isoDaysAgo(SMALL_FUND_WINDOW_YEARS * 365 + 366);
/** 起点当天要能算出 EMA676，首根须早于此（676 根 ≈ 981 自然日）。 */
const VEGAS_READY_BY = isoDaysAgo(SMALL_FUND_WINDOW_YEARS * 365 + 981);

type Outcome = { ticker: string; bars?: number; first?: string; reason?: string };

async function fetchOne(ticker: string): Promise<Outcome> {
  if (!REFETCH && hasCsvPanel(CSV_PANEL_DIR, ticker)) {
    const existing = readCsvPanel(CSV_PANEL_DIR, ticker);
    if (existing) return { ticker, bars: existing.dates.length, first: existing.dates[0] };
  }

  let bars;
  try {
    bars = await fetchYahooDailyBars(ticker, { years: SMALL_FUND_HISTORY_YEARS });
  } catch (error) {
    return { ticker, reason: error instanceof Error ? error.message : "抓取失败" };
  }
  if (bars.length < MIN_BARS) return { ticker, reason: `样本不足 ${bars.length} 根` };

  writeCsvPanel(CSV_PANEL_DIR, ticker, bars);
  return { ticker, bars: bars.length, first: bars[0].date };
}

async function main() {
  console.log(
    `Small Fund 池 ${SMALL_FUND_UNIVERSE.length} 只  抓 ${SMALL_FUND_HISTORY_YEARS} 年  ` +
      `并发 ${CONCURRENCY}${REFETCH ? "  [强制重抓]" : ""}`,
  );
  console.log(`原始清单剔除 ${SMALL_FUND_EXCLUDED.length} 只:`);
  for (const { symbol, reason } of SMALL_FUND_EXCLUDED) {
    console.log(`  ${symbol.padEnd(8)} ${reason}`);
  }
  console.log(`\n输出目录 ${CSV_PANEL_DIR}\n`);

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
    process.stdout.write(
      `\r进度 ${done}/${SMALL_FUND_UNIVERSE.length}  成功 ${ok.length}  失败 ${failed.length}   `,
    );
  }

  const totalBars = ok.reduce((a, r) => a + (r.bars ?? 0), 0);
  console.log(
    `\n\n拿到 ${ok.length} 只  共 ${totalBars.toLocaleString()} 根  ` +
      `目录内共 ${listCsvTickers(CSV_PANEL_DIR).length} 个文件`,
  );

  if (failed.length > 0) {
    console.log(`\n拿不到价格（回测中排除）共 ${failed.length} 只:`);
    for (const f of failed) console.log(`  ${f.ticker.padEnd(8)} ${f.reason}`);
  }

  // 预热覆盖度：这两批标的会在窗口的一部分甚至全程缺席，是本池最需要提前知道的事
  const lateRps = ok.filter((r) => (r.first ?? "") > RPS_READY_BY).sort(cmpFirst);
  const lateVegas = ok.filter((r) => (r.first ?? "") > VEGAS_READY_BY).sort(cmpFirst);

  console.log(`\n回测窗口 ${WINDOW_START} 起，预热覆盖度:`);
  console.log(
    `  截面 RPS（需 252 根）  窗口全程可用 ${ok.length - lateRps.length}/${ok.length}  ` +
      `晚到 ${lateRps.length} 只`,
  );
  console.log(
    `  Vegas（需 EMA676）    窗口全程可用 ${ok.length - lateVegas.length}/${ok.length}  ` +
      `晚到 ${lateVegas.length} 只`,
  );

  if (lateVegas.length > 0) {
    console.log(`\n  Vegas 预热晚于窗口起点的标的（首根日期）:`);
    for (const r of lateVegas) console.log(`    ${r.ticker.padEnd(8)} ${r.first}  ${r.bars} 根`);
  }
}

const cmpFirst = (a: Outcome, b: Outcome) => ((a.first ?? "") < (b.first ?? "") ? -1 : 1);

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
