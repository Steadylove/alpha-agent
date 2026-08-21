import "dotenv/config";

import { fetchFmpProfile } from "@/lib/data-sources/fmp";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import { getPrisma } from "@/lib/db/prisma";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";

/**
 * SLS 3.0 行业时钟需要的两样数据：
 *   1. 11 只 SPDR 行业 ETF 的日线历史
 *   2. 标的池 40 只的 GICS 行业归属（写进 Instrument.sector）
 *
 * 可重复执行：日线有 (instrumentId, date) 唯一约束，行业走 update。
 */

const HISTORY_YEARS = 20;
const INSERT_CHUNK = 2000;

async function backfillSectorEtfs() {
  const prisma = getPrisma();
  console.log("== 回填 11 只行业 ETF 日线 ==");

  for (const etf of SECTOR_UNIVERSE) {
    const bars = await fetchYahooDailyBars(etf.symbol, { years: HISTORY_YEARS });
    if (bars.length === 0) {
      console.error(`✗ ${etf.symbol.padEnd(5)} 无数据`);
      continue;
    }

    const instrument = await prisma.instrument.upsert({
      where: { symbol: etf.symbol },
      update: { name: `${etf.name}板块 ETF`, type: "ETF" },
      create: { symbol: etf.symbol, name: `${etf.name}板块 ETF`, type: "ETF" },
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

    console.log(
      `✓ ${etf.symbol.padEnd(5)} ${etf.name.padEnd(5)} ${String(bars.length).padStart(5)} 根  ` +
        `新增 ${String(written).padStart(5)}  ${bars[0].date} → ${bars.at(-1)!.date}`,
    );
  }
}

async function backfillInstrumentSectors() {
  const prisma = getPrisma();
  console.log("\n== 回填 40 只标的的行业归属 ==");

  const missing: string[] = [];
  for (const target of ROTATION_UNIVERSE) {
    const profile = await fetchFmpProfile(target.symbol);
    if (!profile?.sector) {
      missing.push(target.symbol);
      console.error(`✗ ${target.symbol.padEnd(6)} FMP 无行业数据`);
      continue;
    }

    await prisma.instrument.update({
      where: { symbol: target.symbol },
      data: { sector: profile.sector, industry: profile.industry },
    });

    // ETF 本就没有 GICS 行业，FMP 一律返回 Financial Services，标注出来
    const note = target.type === "ETF" ? "  ← ETF，时钟排名将跳过" : "";
    console.log(
      `✓ ${target.symbol.padEnd(6)} ${profile.sector.padEnd(24)} ${profile.industry ?? ""}${note}`,
    );
  }

  if (missing.length > 0) {
    console.log(`\n无行业数据: ${missing.join(", ")}`);
  }
}

async function main() {
  await backfillSectorEtfs();
  await backfillInstrumentSectors();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrisma().$disconnect();
    process.exit(process.exitCode ?? 0);
  });
