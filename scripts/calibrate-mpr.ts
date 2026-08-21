import "dotenv/config";

import { getPrisma } from "@/lib/db/prisma";
import {
  MPR_SYMBOLS,
  alignMprInputs,
  computeMprSeries,
  type AlignBar,
  type MprSymbol,
} from "@/lib/scoring/mpr";

/**
 * 在全历史上逐日跑 MPR，产出「各 Path 下未来 5 日实际下跌频率」校准表。
 *
 * 这张表回答的是：Pine 里写死的 alpha_base / severity 系数，在真实历史上站不站得住。
 */

/** ECDF 需要 252 根预热，之前的输出无意义，统计时剔除。 */
const WARMUP_BARS = 252;
const FORWARD_DAYS = 5;

async function loadBars(): Promise<Record<MprSymbol, AlignBar[]>> {
  const prisma = getPrisma();
  const result = {} as Record<MprSymbol, AlignBar[]>;

  for (const symbol of MPR_SYMBOLS) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) {
      throw new Error(`Instrument ${symbol} not found. Run: npm run backfill:macro`);
    }
    const bars = await prisma.dailyBar.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { date: "asc" },
      select: { date: true, close: true, volume: true },
    });
    result[symbol] = bars.map((bar) => ({
      date: bar.date.toISOString().slice(0, 10),
      close: bar.close,
      volume: Number(bar.volume),
    }));
  }

  return result;
}

const PATH_NAMES: Record<number, string> = {
  0: "P0 稳态自洽",
  1: "P1 跨市场暗流",
  2: "P2 相变扩散",
  3: "P3 微观漂移",
  4: "P4 破位确认",
};

async function main() {
  const bySymbol = await loadBars();
  const rows = alignMprInputs(bySymbol);
  console.log(`对齐后交易日: ${rows.length} (${rows[0]?.date} → ${rows.at(-1)?.date})`);

  const series = computeMprSeries(rows);
  const closes = rows.map((r) => r.spyClose);

  type Bucket = {
    n: number;
    down: number;
    drop3: number;
    sumRet: number;
    sumPredicted: number;
    fallthrough: number;
  };
  const buckets = new Map<number, Bucket>();

  for (let i = WARMUP_BARS; i < series.length - FORWARD_DAYS; i += 1) {
    const day = series[i];
    const fwd = ((closes[i + FORWARD_DAYS] - closes[i]) / closes[i]) * 100;
    const bucket = buckets.get(day.pathId) ?? {
      n: 0,
      down: 0,
      drop3: 0,
      sumRet: 0,
      sumPredicted: 0,
      fallthrough: 0,
    };
    bucket.n += 1;
    if (fwd < 0) bucket.down += 1;
    if (fwd <= -3) bucket.drop3 += 1;
    bucket.sumRet += fwd;
    bucket.sumPredicted += day.prob5dDown;
    if (day.pathId === 0 && (day.sigmaVol > 0 || day.sigmaCred > 0 || day.sigmaSpot > 0)) {
      bucket.fallthrough += 1;
    }
    buckets.set(day.pathId, bucket);
  }

  const total = [...buckets.values()].reduce((sum, b) => sum + b.n, 0);
  const baseline = [...buckets.values()].reduce((sum, b) => sum + b.down, 0) / total;

  console.log("");
  console.log("Path            样本   占比    5D下跌频率  5D跌>3%   5D平均收益  模型预测概率");
  console.log("─".repeat(88));

  for (const path of [0, 1, 2, 3, 4]) {
    const b = buckets.get(path);
    if (!b || b.n === 0) {
      console.log(`${PATH_NAMES[path].padEnd(14)} ${String(0).padStart(5)}   (无样本)`);
      continue;
    }
    console.log(
      `${PATH_NAMES[path].padEnd(14)} ${String(b.n).padStart(5)} ` +
        `${((b.n / total) * 100).toFixed(1).padStart(6)}% ` +
        `${((b.down / b.n) * 100).toFixed(1).padStart(10)}% ` +
        `${((b.drop3 / b.n) * 100).toFixed(1).padStart(8)}% ` +
        `${(b.sumRet / b.n).toFixed(2).padStart(11)}% ` +
        `${(b.sumPredicted / b.n).toFixed(1).padStart(12)}%`,
    );
  }

  console.log("");
  console.log(`全样本基准下跌频率: ${(baseline * 100).toFixed(1)}%（任一 Path 需显著偏离才有信息量）`);

  const p0 = buckets.get(0);
  if (p0 && p0.n > 0) {
    console.log(
      `Path 0 兜底占比: ${((p0.fallthrough / p0.n) * 100).toFixed(1)}% ` +
        `(${p0.fallthrough}/${p0.n} 天并非三域全静，见总纲未决问题 4)`,
    );
  }

  // ---- 力场与三域的基准分布 ----
  // 没有这一段，上面那张表只能看出「不单调」，看不出为什么不单调。
  const effective = series.slice(WARMUP_BARS);
  const shareAtLeast = (values: number[], threshold: number) =>
    (values.filter((v) => v >= threshold).length / values.length) * 100;
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)];
  };

  console.log("");
  console.log("力场与三域分布(解释上表为何不单调)");
  console.log("─".repeat(64));
  console.log("指标        中位数    >=50 占比   >=75 占比");
  for (const key of ["f1", "f2", "f3", "f4", "f5", "domVol", "domCred", "domSpot"] as const) {
    const values = effective.map((d) => d[key]);
    console.log(
      `${key.padEnd(10)} ${median(values).toFixed(1).padStart(6)} ` +
        `${shareAtLeast(values, 50).toFixed(1).padStart(10)}% ` +
        `${shareAtLeast(values, 75).toFixed(1).padStart(10)}%`,
    );
  }

  console.log("");
  console.log("判读要点：");
  console.log("  - 「5D下跌频率」应随 Path 序号单调上升，否则路径分级没有区分度。");
  console.log("  - 「模型预测概率」与「5D下跌频率」的差距即 alpha_base 的校准误差。");
  console.log("  - domCred/domSpot 取的是两个 ECDF 分位的 max，其理论中位数是 70.7 而非 50。");
  console.log("    阈值却仍设在 50/75，导致这两个域天然长期处于「异动」，是不单调的主因。");

  await getPrisma().$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await getPrisma().$disconnect();
  process.exit(1);
});
