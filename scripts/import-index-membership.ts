import "dotenv/config";

import { fetchNasdaq100Membership } from "@/lib/data-sources/nasdaq100Historical";
import { fetchSp500Membership } from "@/lib/data-sources/sp500Historical";
import { getPrisma } from "@/lib/db/prisma";

/**
 * 导入时点成分资格区间。用 `--index=NDX100` 切换指数，默认 SP500。
 *
 * 可重复执行：(index, ticker, startDate) 上有唯一约束，重跑只补增量。
 * 不写 hasBars/barCount，那两列由 backfill-sp500-panel 负责。
 */

const INSERT_CHUNK = 1000;

const INDEXES = {
  SP500: { label: "标普 500", fetch: fetchSp500Membership },
  NDX100: { label: "纳斯达克 100", fetch: fetchNasdaq100Membership },
} as const;

type IndexKey = keyof typeof INDEXES;

function parseIndex(): IndexKey {
  const arg = process.argv.find((a) => a.startsWith("--index="));
  const key = (arg?.split("=")[1] ?? "SP500").toUpperCase();
  if (!(key in INDEXES)) {
    throw new Error(`未知指数 ${key}，可用: ${Object.keys(INDEXES).join(", ")}`);
  }
  return key as IndexKey;
}

async function main() {
  const prisma = getPrisma();
  const indexKey = parseIndex();
  const spec = INDEXES[indexKey];
  console.log(`指数: ${spec.label} (${indexKey})\n`);

  const result = await spec.fetch();
  const { intervals, firstDate, lastDate } = result;
  const snapshotCount = "snapshotCount" in result ? result.snapshotCount : null;

  const tickers = new Set(intervals.map((i) => i.ticker));
  const stillIn = intervals.filter((i) => i.end == null);
  const multi = [...tickers].filter(
    (t) => intervals.filter((i) => i.ticker === t).length > 1,
  );

  if (snapshotCount != null) console.log(`快照 ${snapshotCount} 个变更日`);
  console.log(`区间 ${intervals.length} 段，覆盖 ${tickers.size} 个 ticker  ${firstDate} → ${lastDate}`);
  console.log(`仍在指数内: ${stillIn.length}`);
  console.log(`多次进出指数的 ticker: ${multi.length} 个${multi.length ? `，例: ${multi.slice(0, 8).join(", ")}` : ""}`);

  let written = 0;
  for (let i = 0; i < intervals.length; i += INSERT_CHUNK) {
    const chunk = intervals.slice(i, i + INSERT_CHUNK).map((iv) => ({
      index: indexKey,
      ticker: iv.ticker,
      startDate: new Date(`${iv.start}T00:00:00.000Z`),
      endDate: iv.end ? new Date(`${iv.end}T00:00:00.000Z`) : null,
    }));
    const res = await prisma.indexMembership.createMany({ data: chunk, skipDuplicates: true });
    written += res.count;
  }

  console.log(
    `\n落库: 新增 ${written} 段，${indexKey} 合计 ` +
      `${await prisma.indexMembership.count({ where: { index: indexKey } })} 段`,
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
