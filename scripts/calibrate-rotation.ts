import "dotenv/config";

import { getPrisma } from "@/lib/db/prisma";
import { computeLogMacdSeries, type LogMacdBar } from "@/lib/scoring/logMacd";
import { rotationRsSeries } from "@/lib/scoring/rotationRs";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";

/**
 * 在全历史上逐日跑轮动雷达的一买/二买，产出信号后的前向收益分布。
 *
 * 这张表回答两件事：
 *   1. 引擎在真实数据上到底出不出信号（单测里多是负向断言，不能证明这点）
 *   2. 一买/二买相对「随机某天买入」有没有超额
 */

const HORIZONS = [5, 10, 20, 60];
/** EMA90 + DEA 预热，之前的输出不可信。 */
const WARMUP_BARS = 120;

type Loaded = { symbol: string; bars: LogMacdBar[] };

async function loadBars(): Promise<{ loaded: Loaded[]; missing: string[] }> {
  const prisma = getPrisma();
  const loaded: Loaded[] = [];
  const missing: string[] = [];

  for (const { symbol } of ROTATION_UNIVERSE) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) {
      missing.push(symbol);
      continue;
    }
    const bars = await prisma.dailyBar.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { date: "asc" },
      select: { high: true, low: true, close: true },
    });
    if (bars.length < WARMUP_BARS + 60) {
      missing.push(`${symbol}(${bars.length}根)`);
      continue;
    }
    loaded.push({ symbol, bars });
  }

  return { loaded, missing };
}

type Sample = { symbol: string; index: number; rs: number; forward: (number | null)[] };

function summarize(label: string, samples: Sample[], horizonIdx: number) {
  const rets = samples.map((s) => s.forward[horizonIdx]).filter((r): r is number => r != null);
  if (rets.length === 0) return `${label.padEnd(14)} ${"n=0".padStart(7)}`;

  const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
  const win = (rets.filter((r) => r > 0).length / rets.length) * 100;
  const sorted = [...rets].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  return [
    label.padEnd(14),
    `n=${rets.length}`.padStart(7),
    `均值 ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%`.padStart(14),
    `中位 ${median >= 0 ? "+" : ""}${median.toFixed(2)}%`.padStart(14),
    `胜率 ${win.toFixed(1)}%`.padStart(12),
  ].join("  ");
}

async function main() {
  const { loaded, missing } = await loadBars();
  console.log(`标的池: ${loaded.length}/${ROTATION_UNIVERSE.length} 可用`);
  if (missing.length > 0) console.log(`数据不足: ${missing.join(", ")}\n`);

  const buy1: Sample[] = [];
  const buy2: Sample[] = [];
  const baseline: Sample[] = [];
  const perSymbol: { symbol: string; b1: number; b2: number; bars: number }[] = [];

  for (const { symbol, bars } of loaded) {
    const closes = bars.map((b) => b.close);
    const macd = computeLogMacdSeries(bars);
    const rs = rotationRsSeries(closes);

    const forwardAt = (i: number) =>
      HORIZONS.map((h) => {
        const future = closes[i + h];
        return future == null ? null : ((future - closes[i]) / closes[i]) * 100;
      });

    let b1 = 0;
    let b2 = 0;
    for (let i = WARMUP_BARS; i < bars.length; i += 1) {
      const sample = { symbol, index: i, rs: rs[i]!, forward: forwardAt(i) };
      baseline.push(sample);
      if (macd[i].buy1) {
        buy1.push(sample);
        b1 += 1;
      }
      if (macd[i].buy2) {
        buy2.push(sample);
        b2 += 1;
      }
    }
    perSymbol.push({ symbol, b1, b2, bars: bars.length });
  }

  console.log("── 各标的信号数 ──");
  for (const r of perSymbol.sort((a, b) => b.b1 + b.b2 - (a.b1 + a.b2))) {
    console.log(
      `${r.symbol.padEnd(6)} ${String(r.bars).padStart(5)}根  一买 ${String(r.b1).padStart(3)}  二买 ${String(r.b2).padStart(3)}`,
    );
  }

  const totalB1 = buy1.length;
  const totalB2 = buy2.length;
  console.log(
    `\n合计: 一买 ${totalB1}  二买 ${totalB2}  基准样本 ${baseline.length}` +
      `  (信号密度 ${(((totalB1 + totalB2) / baseline.length) * 100).toFixed(2)}%)`,
  );

  for (let h = 0; h < HORIZONS.length; h += 1) {
    console.log(`\n── 前向 ${HORIZONS[h]} 日收益 ──`);
    console.log(summarize("❤️ 一买", buy1, h));
    console.log(summarize("⭐️ 二买", buy2, h));
    console.log(summarize("基准(全样本)", baseline, h));
  }

  // 信号集中在低 RS 区间，直接和全样本比会把「低 RS 标的本身的表现」算进信号头上。
  // 只有在同一 RS 区间内对照，才能分离出背离形态自身的贡献。
  const RS_BUCKETS = [
    { label: "RS <30", lo: 0, hi: 30 },
    { label: "RS 30-45", lo: 30, hi: 45 },
    { label: "RS 45-60", lo: 45, hi: 60 },
    { label: "RS >=60", lo: 60, hi: 100 },
  ];
  const meanAt = (set: Sample[], h: number) => {
    const rets = set.map((s) => s.forward[h]).filter((r): r is number => r != null);
    return rets.length === 0 ? null : rets.reduce((a, b) => a + b, 0) / rets.length;
  };

  for (const h of [2, 3]) {
    console.log(`\n── 同 RS 区间内对照（前向 ${HORIZONS[h]} 日均值）──`);
    for (const bucket of RS_BUCKETS) {
      const inBucket = (s: Sample) => s.rs >= bucket.lo && s.rs < bucket.hi;
      const sig = buy1.filter(inBucket);
      const base = baseline.filter(inBucket);
      const sigMean = meanAt(sig, h);
      const baseMean = meanAt(base, h);
      if (sigMean == null || baseMean == null) {
        console.log(`${bucket.label.padEnd(10)} 一买 n=${sig.length} 样本不足`);
        continue;
      }
      const edge = sigMean - baseMean;
      console.log(
        `${bucket.label.padEnd(10)} 一买 n=${String(sig.length).padStart(3)} ` +
          `${sigMean >= 0 ? "+" : ""}${sigMean.toFixed(2)}%   ` +
          `同区间基准 ${baseMean >= 0 ? "+" : ""}${baseMean.toFixed(2)}%   ` +
          `超额 ${edge >= 0 ? "+" : ""}${edge.toFixed(2)}pp`,
      );
    }
  }

  console.log("\n── 信号触发时的 RS 分布 ──");
  for (const [label, set] of [
    ["❤️ 一买", buy1],
    ["⭐️ 二买", buy2],
    ["基准", baseline],
  ] as const) {
    if (set.length === 0) {
      console.log(`${label.padEnd(14)} n=0`);
      continue;
    }
    const vals = set.map((s) => s.rs).sort((a, b) => a - b);
    const q = (p: number) => vals[Math.floor(p * (vals.length - 1))].toFixed(1);
    console.log(
      `${label.padEnd(14)} p10 ${q(0.1).padStart(5)}  中位 ${q(0.5).padStart(5)}  p90 ${q(0.9).padStart(5)}` +
        `  RS>=70 占比 ${((vals.filter((v) => v >= 70).length / vals.length) * 100).toFixed(1)}%`,
    );
  }

  await getPrisma().$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
