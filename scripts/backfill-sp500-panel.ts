import "dotenv/config";

import { packPanel } from "@/lib/backtest/panel";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import { getPrisma } from "@/lib/db/prisma";

/**
 * 回填标普池的回测面板。
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

type Outcome = { ticker: string; ok: boolean; bars: number; reason?: string };

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
  };

  await prisma.backtestPanel.upsert({
    where: { ticker },
    update: data,
    create: { ticker, ...data },
  });
  await prisma.indexMembership.updateMany({
    where: { ticker },
    data: { hasBars: true, barCount: packed.barCount },
  });

  return { ticker, ok: true, bars: packed.barCount };
}

async function main() {
  const prisma = getPrisma();
  const targets = await loadTargets();
  const existing = new Set(
    (await prisma.backtestPanel.findMany({ select: { ticker: true } })).map((r) => r.ticker),
  );
  const todo = targets.filter((t) => !existing.has(t));

  console.log(
    `成分资格与近 ${HISTORY_YEARS} 年有交集: ${targets.length} 个 ticker\n` +
      `已有面板 ${existing.size} 个，本次需抓 ${todo.length} 个\n`,
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

  const withBars = await prisma.indexMembership.count({ where: { hasBars: true } });
  const total = await prisma.indexMembership.count();
  console.log(
    `\n成分区间覆盖率: ${withBars}/${total} 段有价格 ` +
      `(${((withBars / total) * 100).toFixed(0)}%)`,
  );

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
