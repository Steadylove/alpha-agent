import "dotenv/config";

import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import { getPrisma } from "@/lib/db/prisma";
import { ROTATION_UNIVERSE, type RotationTarget } from "@/lib/scoring/rotationUniverse";

/**
 * 回填轮动雷达 40 只标的的日线历史。
 *
 * 对数 MACD 需要 EMA90 预热，RS 需要 252 根回看，故至少要 1.5 年才有第一个有效值；
 * 这里按 20 年抓全，不足年限的次新股由 Yahoo 自然截断。
 *
 * 可重复执行：DailyBar 在 (instrumentId, date) 上有唯一约束，重跑只补增量。
 */

const HISTORY_YEARS = 20;
/** Postgres 单条语句参数上限 65535，DailyBar 约 8 列，留足余量。 */
const INSERT_CHUNK = 2000;

async function backfillOne(target: RotationTarget) {
  const prisma = getPrisma();
  const bars = await fetchYahooDailyBars(target.symbol, { years: HISTORY_YEARS });

  if (bars.length === 0) {
    throw new Error(`No bars returned for ${target.symbol}`);
  }

  const instrument = await prisma.instrument.upsert({
    where: { symbol: target.symbol },
    update: { name: target.name, type: target.type },
    create: { symbol: target.symbol, name: target.name, type: target.type },
  });

  let written = 0;
  for (let i = 0; i < bars.length; i += INSERT_CHUNK) {
    const chunk = bars.slice(i, i + INSERT_CHUNK).map((bar) => ({
      instrumentId: instrument.id,
      date: new Date(`${bar.date}T00:00:00.000Z`),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: BigInt(Math.max(0, Math.round(bar.volume))),
      source: bar.source,
    }));

    const result = await prisma.dailyBar.createMany({ data: chunk, skipDuplicates: true });
    written += result.count;
  }

  return {
    symbol: target.symbol,
    fetched: bars.length,
    written,
    from: bars[0].date,
    to: bars[bars.length - 1].date,
  };
}

async function main() {
  const rows: Array<Awaited<ReturnType<typeof backfillOne>>> = [];
  const failures: Array<{ symbol: string; error: string }> = [];

  for (const target of ROTATION_UNIVERSE) {
    try {
      const row = await backfillOne(target);
      rows.push(row);
      console.log(
        `✓ ${row.symbol.padEnd(6)} ${String(row.fetched).padStart(5)} 根  ` +
          `新增 ${String(row.written).padStart(5)}  ${row.from} → ${row.to}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ symbol: target.symbol, error: message });
      console.error(`✗ ${target.symbol.padEnd(6)} ${message}`);
    }
  }

  console.log("");
  console.log(`标的: ${rows.length}/${ROTATION_UNIVERSE.length} 成功`);
  console.log(`落库: ${rows.reduce((sum, row) => sum + row.written, 0)} 根新增日线`);

  // 对数 MACD 的 EMA90 + RS 的 252 根回看，样本太短的标的信号不可信。
  const shallow = rows.filter((row) => row.fetched < 400);
  if (shallow.length > 0) {
    console.log(
      `样本不足 400 根（信号需谨慎解读）: ${shallow.map((r) => `${r.symbol}(${r.fetched})`).join(", ")}`,
    );
  }
  if (failures.length > 0) {
    console.log(`失败: ${failures.map((f) => f.symbol).join(", ")}`);
    process.exitCode = 1;
  }
}

async function disconnectPrisma() {
  try {
    await getPrisma().$disconnect();
  } catch {
    // The script may fail before Prisma is initialized.
  }
}

main()
  .then(async () => {
    await disconnectPrisma();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (error) => {
    console.error(error);
    await disconnectPrisma();
    process.exit(1);
  });
