import "dotenv/config";

import { fetchCboeVolIndexHistory, type CboeVolIndex } from "@/lib/data-sources/cboe";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import { getPrisma } from "@/lib/db/prisma";
import type { DailyBar, InstrumentType } from "@/lib/types/market";

/**
 * 回填 MPR 相变引擎所需的宏观标的全历史日线。
 *
 * 五大力场的数据依赖：
 *   F1 量价推进效率   -> SPY
 *   F2 隐波期限倒挂   -> VIX9D / VIX3M（VIX 作为阈值滤波）
 *   F3 跨资产避险脱节 -> TLT / UUP / GLD
 *   F4 信用利差紧缩   -> IEI / HYG
 *   F5 现货广度背离   -> SPY / RSP
 *
 * 可重复执行：DailyBar 在 (instrumentId, date) 上有唯一约束，重跑只补增量。
 */

type MacroTarget = {
  symbol: string;
  /** 数据源侧的代码。仅当与入库 symbol 不同时才需要，如 DXY 在 Yahoo 上是 DX-Y.NYB。 */
  fetchSymbol?: string;
  name: string;
  type: InstrumentType;
  /** yahoo=ETF 行情；cboe=波动率指数全历史 CSV */
  source: "yahoo" | "cboe";
  role: string;
};

const MACRO_TARGETS: MacroTarget[] = [
  { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", type: "ETF", source: "yahoo", role: "F1/F5 现货基准" },
  { symbol: "RSP", name: "Invesco S&P 500 Equal Weight ETF", type: "ETF", source: "yahoo", role: "F5 等权广度" },
  { symbol: "TLT", name: "iShares 20+ Year Treasury Bond ETF", type: "ETF", source: "yahoo", role: "F3 长债避险" },
  { symbol: "UUP", name: "Invesco DB US Dollar Index Bullish Fund", type: "ETF", source: "yahoo", role: "F3 美元代理" },
  { symbol: "DXY", fetchSymbol: "DX-Y.NYB", name: "ICE US Dollar Index", type: "INDEX", source: "yahoo", role: "F3 美元指数" },
  { symbol: "GLD", name: "SPDR Gold Shares", type: "ETF", source: "yahoo", role: "F3 黄金避险" },
  { symbol: "IEI", name: "iShares 3-7 Year Treasury Bond ETF", type: "ETF", source: "yahoo", role: "F4 中期国债" },
  { symbol: "HYG", name: "iShares iBoxx High Yield Corporate Bond ETF", type: "ETF", source: "yahoo", role: "F4 高收益债" },
  { symbol: "VIX", name: "CBOE Volatility Index", type: "INDEX", source: "cboe", role: "F2 阈值滤波" },
  { symbol: "VIX9D", name: "CBOE 9-Day Volatility Index", type: "INDEX", source: "cboe", role: "F2 短端隐波" },
  { symbol: "VIX3M", name: "CBOE 3-Month Volatility Index", type: "INDEX", source: "cboe", role: "F2 远端隐波" },
];

const HISTORY_YEARS = 20;
/** Postgres 单条语句参数上限 65535，DailyBar 约 8 列，留足余量。 */
const INSERT_CHUNK = 2000;

async function fetchHistory(target: MacroTarget): Promise<DailyBar[]> {
  if (target.source === "cboe") {
    return fetchCboeVolIndexHistory(target.symbol as CboeVolIndex);
  }
  return fetchYahooDailyBars(target.fetchSymbol ?? target.symbol, { years: HISTORY_YEARS });
}

async function backfillOne(target: MacroTarget) {
  const prisma = getPrisma();
  const bars = await fetchHistory(target);

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
    role: target.role,
    fetched: bars.length,
    written,
    from: bars[0].date,
    to: bars[bars.length - 1].date,
  };
}

async function main() {
  const rows: Array<Awaited<ReturnType<typeof backfillOne>>> = [];
  const failures: Array<{ symbol: string; error: string }> = [];

  for (const target of MACRO_TARGETS) {
    try {
      const row = await backfillOne(target);
      rows.push(row);
      console.log(
        `✓ ${row.symbol.padEnd(6)} ${String(row.fetched).padStart(5)} 根  ` +
          `新增 ${String(row.written).padStart(5)}  ${row.from} → ${row.to}  (${row.role})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ symbol: target.symbol, error: message });
      console.error(`✗ ${target.symbol.padEnd(6)} ${message}`);
    }
  }

  // MPR 五力场需要全部力场同时可用，校准窗口由最晚开始的序列决定。
  const calibrationStart = rows.reduce<string | null>(
    (latest, row) => (latest == null || row.from > latest ? row.from : latest),
    null,
  );

  console.log("");
  console.log(`标的: ${rows.length}/${MACRO_TARGETS.length} 成功`);
  console.log(`落库: ${rows.reduce((sum, row) => sum + row.written, 0)} 根新增日线`);
  if (calibrationStart) {
    console.log(`MPR 校准窗口起点: ${calibrationStart}（受最晚上线的序列约束）`);
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
