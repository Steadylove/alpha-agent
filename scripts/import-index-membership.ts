import "dotenv/config";

import { fetchSp500Membership } from "@/lib/data-sources/sp500Historical";
import { getPrisma } from "@/lib/db/prisma";

/**
 * 导入标普 500 的时点成分资格区间。
 *
 * 可重复执行：(index, ticker, startDate) 上有唯一约束，重跑只补增量。
 * 不写 hasBars/barCount，那两列由 backfill-sp500-bars 负责。
 */

const INSERT_CHUNK = 1000;

async function main() {
  const prisma = getPrisma();
  const { intervals, snapshotCount, firstDate, lastDate } = await fetchSp500Membership();

  const tickers = new Set(intervals.map((i) => i.ticker));
  const stillIn = intervals.filter((i) => i.end == null);
  const multi = [...tickers].filter(
    (t) => intervals.filter((i) => i.ticker === t).length > 1,
  );

  console.log(`快照 ${snapshotCount} 个变更日  ${firstDate} → ${lastDate}`);
  console.log(`区间 ${intervals.length} 段，覆盖 ${tickers.size} 个 ticker`);
  console.log(`仍在指数内: ${stillIn.length}`);
  console.log(`多次进出指数的 ticker: ${multi.length} 个${multi.length ? `，例: ${multi.slice(0, 8).join(", ")}` : ""}`);

  let written = 0;
  for (let i = 0; i < intervals.length; i += INSERT_CHUNK) {
    const chunk = intervals.slice(i, i + INSERT_CHUNK).map((iv) => ({
      index: "SP500",
      ticker: iv.ticker,
      startDate: new Date(`${iv.start}T00:00:00.000Z`),
      endDate: iv.end ? new Date(`${iv.end}T00:00:00.000Z`) : null,
    }));
    const res = await prisma.indexMembership.createMany({ data: chunk, skipDuplicates: true });
    written += res.count;
  }

  console.log(`\n落库: 新增 ${written} 段，表内合计 ${await prisma.indexMembership.count()} 段`);
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
