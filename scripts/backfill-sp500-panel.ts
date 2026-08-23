import "dotenv/config";

import { packPanel } from "@/lib/backtest/panel";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import { getPrisma } from "@/lib/db/prisma";

/**
 * 回填回测面板，覆盖 IndexMembership 里**所有**已导入指数的成分（SP500 + NDX100）。
 *
 * 面板按 ticker 存、不分指数：价格数据与指数归属无关，两个指数重叠的标的
 * （AAPL、MSFT 之类）只需一份。指数归属留在 IndexMembership 里按 index 列区分。
 *
 * 只抓成分资格与回测窗口有交集的 ticker：在 2006 年前就已离开指数的标的
 * 对 20 年窗口没有影响，抓了也用不上。
 *
 * 退市标的在 Yahoo 取不到价格，失败即跳过并把 hasBars 留为 false，
 * 回测时按此列排除。这是本项目已知的残留幸存者偏差，见 sp500Historical.ts。
 *
 * 可重复执行：已有面板且 barCount 相符的 ticker 直接跳过。
 */

const HISTORY_YEARS = 20;
/** 重试失败批次时设为 1：并发下 Yahoo 会限流，限流与真退市都表现为取不到数据。 */
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? 6);
/** 基准标的不是指数成分，但截面 RS 要用它算超额。 */
const EXTRA_TICKERS = ["SPY"];
/** 对数 MACD 的 EMA90 与 RS 的 252 根回看，短于此的样本信号不可信。 */
const MIN_BARS = 400;

type Outcome = {
  ticker: string;
  ok: boolean;
  bars: number;
  reason?: string;
  /** 首末日之间缺失的交易日数，按周一至周五粗算 */
  gaps?: number;
};

/**
 * 粗算首末日之间缺了多少个交易日。
 *
 * 用工作日数当基准而非真实交易日历：这里只要一个「有没有洞」的量级信号，
 * 每年 9~10 个法定休市日会让所有标的都显示约 190 天的虚假缺口，
 * 因此阈值取得足够高，只报真正异常的。
 */
function countGaps(dates: readonly string[]): number {
  const first = Date.parse(`${dates[0]}T00:00:00Z`);
  const last = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`);
  const days = Math.round((last - first) / 86_400_000) + 1;
  const weekdays = Math.round((days / 7) * 5);
  return Math.max(0, weekdays - dates.length);
}

async function loadTargets(): Promise<string[]> {
  const prisma = getPrisma();
  const cutoff = new Date(Date.now() - HISTORY_YEARS * 365 * 24 * 60 * 60 * 1000);

  const rows = await prisma.indexMembership.findMany({
    where: { OR: [{ endDate: null }, { endDate: { gte: cutoff } }] },
    select: { ticker: true },
    distinct: ["ticker"],
    orderBy: { ticker: "asc" },
  });
  return [...new Set([...EXTRA_TICKERS, ...rows.map((r) => r.ticker)])];
}

async function backfillOne(ticker: string): Promise<Outcome> {
  const prisma = getPrisma();

  let bars;
  try {
    bars = await fetchYahooDailyBars(ticker, { years: HISTORY_YEARS });
  } catch (error) {
    return { ticker, ok: false, bars: 0, reason: error instanceof Error ? error.message : "抓取失败" };
  }

  if (bars.length < MIN_BARS) {
    return { ticker, ok: false, bars: bars.length, reason: `样本不足 ${bars.length} 根` };
  }

  const packed = packPanel(bars);
  const data = {
    firstDate: packed.firstDate,
    lastDate: packed.lastDate,
    barCount: packed.barCount,
    days: packed.days,
    high: packed.high,
    low: packed.low,
    close: packed.close,
    volume: packed.volume,
    open: packed.open,
  };

  await prisma.backtestPanel.upsert({
    where: { ticker },
    update: data,
    create: { ticker, ...data },
  });
  return {
    ticker,
    ok: true,
    bars: packed.barCount,
    gaps: countGaps(bars.map((b) => b.date)),
  };
}

/**
 * 按面板表回刷 IndexMembership 的 hasBars / barCount。
 *
 * hasBars 必须是从面板**推导**出来的，不能当作抓取的副作用来写：面板按
 * ticker 存、成分段按 (index, ticker) 存，本轮被跳过的 ticker（面板已齐备）
 * 不会触发抓取，若只在抓取时回写，新导入指数的成分段会永远停在 false。
 * NDX100 刚导入时 102 个现役成分只认出 50 段，就是这个原因。
 */
async function reconcileHasBars(): Promise<void> {
  const prisma = getPrisma();
  const panels = await prisma.backtestPanel.findMany({
    select: { ticker: true, barCount: true },
  });

  const byCount = new Map<number, string[]>();
  for (const p of panels) {
    byCount.set(p.barCount, [...(byCount.get(p.barCount) ?? []), p.ticker]);
  }

  for (const [barCount, tickers] of byCount) {
    await prisma.indexMembership.updateMany({
      where: { ticker: { in: tickers } },
      data: { hasBars: true, barCount },
    });
  }

  await prisma.indexMembership.updateMany({
    where: { ticker: { notIn: panels.map((p) => p.ticker) } },
    data: { hasBars: false, barCount: null },
  });
}

async function main() {
  const prisma = getPrisma();
  const targets = await loadTargets();
  const rows = await prisma.backtestPanel.findMany({
    select: { ticker: true, volume: true, open: true },
  });
  // 只有价量与开盘价都齐的才算完成：加这两列之前落库的行为 null，需要重抓
  const complete = new Set(
    rows.filter((r) => r.volume != null && r.open != null).map((r) => r.ticker),
  );
  const todo = targets.filter((t) => !complete.has(t));

  console.log(
    `成分资格与近 ${HISTORY_YEARS} 年有交集: ${targets.length} 个 ticker\n` +
      `已有面板 ${rows.length} 个，其中价量齐备 ${complete.size} 个，本次需抓 ${todo.length} 个\n`,
  );

  const results: Outcome[] = [];
  let done = 0;

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(batch.map(backfillOne));
    results.push(...settled);
    done += batch.length;

    const ok = results.filter((r) => r.ok).length;
    process.stdout.write(
      `\r进度 ${done}/${todo.length}  成功 ${ok}  失败 ${results.length - ok}   `,
    );
  }

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log(`\n\n成功 ${ok.length}  失败 ${failed.length}`);
  console.log(`落库 ${ok.reduce((s, r) => s + r.bars, 0)} 根日线`);

  // 每年约 9~10 个法定休市日，20 年窗口的正常缺口在 190~200 天量级；
  // 明显超出的说明该标的成交稀疏或数据有洞，回看窗口会被拉长。
  const holey = ok
    .filter((r) => (r.gaps ?? 0) > 260)
    .sort((a, b) => (b.gaps ?? 0) - (a.gaps ?? 0));
  if (holey.length > 0) {
    console.log(
      `\n交易日缺口偏多（成交稀疏或数据有洞，回看窗口会被拉长）共 ${holey.length} 个:`,
    );
    console.log(`  ${holey.slice(0, 15).map((r) => `${r.ticker}(${r.gaps})`).join("  ")}`);
    console.log(`  注：不做插值填充——凭空造出的走平 K 线会直接污染 ATR 与 MACD。`);
  }

  if (failed.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const f of failed) {
      const key = f.reason?.slice(0, 60) ?? "未知";
      byReason.set(key, [...(byReason.get(key) ?? []), f.ticker]);
    }
    console.log(`\n拿不到价格（视为已退市，回测中排除）共 ${failed.length} 个:`);
    for (const [reason, tickers] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  [${tickers.length}] ${reason}`);
      console.log(`  ${tickers.join(", ")}`);
    }
  }

  await reconcileHasBars();

  const byIndex = await prisma.indexMembership.groupBy({
    by: ["index", "hasBars"],
    _count: true,
  });
  console.log("\n成分区间覆盖率（按指数）:");
  for (const idx of [...new Set(byIndex.map((r) => r.index))].sort()) {
    const rows = byIndex.filter((r) => r.index === idx);
    const withBars = rows.find((r) => r.hasBars)?._count ?? 0;
    const total = rows.reduce((s, r) => s + r._count, 0);
    console.log(
      `  ${idx.padEnd(7)} ${withBars}/${total} 段有价格 (${((withBars / total) * 100).toFixed(0)}%)`,
    );
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await getPrisma().$disconnect();
  } catch {
    // Prisma 初始化前就失败
  }
  process.exit(1);
});
