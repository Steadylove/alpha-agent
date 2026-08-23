import "dotenv/config";

import { getPrisma } from "@/lib/db/prisma";
import { computeLogMacdSeries, type LogMacdBar } from "@/lib/scoring/logMacd";
import { rotationRsSeries } from "@/lib/scoring/rotationRs";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { emaSeries } from "@/lib/scoring/series";

/**
 * 入场择时的消融对照：MACD 底背离相对「一条朴素回踩规则」有没有增量。
 *
 * 同一 RS 区间内三方对照，隔离掉「强势股本身涨得多」的贡献：
 *   1. 不择时   —— 区间内任意一天买入，即 calibrate-rotation 的同区间基准
 *   2. 朴素回踩 —— ema20 > ema50 且收盘首次跌回 ema20，无任何背离机制
 *   3. MACD 一买 —— 现有引擎
 *
 * 若 2 与 3 的超额相当，则 logMacd 那套动态回溯/量级规约对结果无贡献。
 */

const HORIZONS = [20, 60];
/** 与 calibrate-rotation 保持一致，ema50/DEA 预热前的输出不可信。 */
const WARMUP_BARS = 120;
/** 与 logMacd 的 barssince(cond[1]) > 10 对齐，避免同一轮回踩被反复计数。 */
const COOLDOWN_BARS = 10;

type Loaded = { symbol: string; bars: LogMacdBar[] };
type Sample = { rs: number; forward: (number | null)[] };

async function loadBars(): Promise<Loaded[]> {
  const prisma = getPrisma();
  const loaded: Loaded[] = [];

  for (const { symbol } of ROTATION_UNIVERSE) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) continue;
    const bars = await prisma.dailyBar.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { date: "asc" },
      select: { high: true, low: true, close: true },
    });
    if (bars.length < WARMUP_BARS + 60) continue;
    loaded.push({ symbol, bars });
  }

  return loaded;
}

/** 上升趋势中价格首次回落到 ema20：仅 ema20/ema50 两条均线，无其他机制。 */
function naivePullback(closes: number[]): boolean[] {
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const out: boolean[] = new Array(closes.length).fill(false);

  let lastFired = -Infinity;
  for (let i = 1; i < closes.length; i += 1) {
    const e20 = ema20[i];
    const e50 = ema50[i];
    const e20Prev = ema20[i - 1];
    if (e20 == null || e50 == null || e20Prev == null) continue;

    const uptrend = e20 > e50;
    const firstTouch = closes[i] <= e20 && closes[i - 1] > e20Prev;
    if (uptrend && firstTouch && i - lastFired > COOLDOWN_BARS) {
      out[i] = true;
      lastFired = i;
    }
  }
  return out;
}

const meanAt = (set: Sample[], h: number) => {
  const rets = set.map((s) => s.forward[h]).filter((r): r is number => r != null);
  return rets.length === 0 ? null : rets.reduce((a, b) => a + b, 0) / rets.length;
};

const RS_BUCKETS = [
  { label: "RS <30", lo: 0, hi: 30 },
  { label: "RS 30-45", lo: 30, hi: 45 },
  { label: "RS 45-60", lo: 45, hi: 60 },
  { label: "RS >=60", lo: 60, hi: 100 },
];

function cell(set: Sample[], base: number, h: number): string {
  const m = meanAt(set, h);
  if (m == null) return `${"样本不足".padStart(14)} n=${String(set.length).padStart(4)}`;
  const edge = m - base;
  return (
    `${`${m >= 0 ? "+" : ""}${m.toFixed(2)}%`.padStart(8)} ` +
    `${`(${edge >= 0 ? "+" : ""}${edge.toFixed(2)}pp)`.padStart(10)} ` +
    `n=${String(set.length).padStart(4)}`
  );
}

async function main() {
  const loaded = await loadBars();
  console.log(`标的池: ${loaded.length} 只\n`);

  const baseline: Sample[] = [];
  const pullback: Sample[] = [];
  const macdBuy1: Sample[] = [];

  for (const { bars } of loaded) {
    const closes = bars.map((b) => b.close);
    const macd = computeLogMacdSeries(bars);
    const rs = rotationRsSeries(closes);
    const dip = naivePullback(closes);

    for (let i = WARMUP_BARS; i < bars.length; i += 1) {
      const sample: Sample = {
        rs: rs[i]!,
        forward: HORIZONS.map((h) => {
          const future = closes[i + h];
          return future == null ? null : ((future - closes[i]) / closes[i]) * 100;
        }),
      };
      baseline.push(sample);
      if (dip[i]) pullback.push(sample);
      if (macd[i].buy1) macdBuy1.push(sample);
    }
  }

  console.log(
    `信号数: 朴素回踩 ${pullback.length}  MACD 一买 ${macdBuy1.length}  基准样本 ${baseline.length}`,
  );

  console.log("\n── 触发时的 RS 分布 ──");
  for (const [label, set] of [
    ["朴素回踩", pullback],
    ["MACD 一买", macdBuy1],
    ["基准", baseline],
  ] as const) {
    const vals = set.map((s) => s.rs).sort((a, b) => a - b);
    const q = (p: number) => vals[Math.floor(p * (vals.length - 1))].toFixed(1);
    console.log(
      `${label.padEnd(11)} p10 ${q(0.1).padStart(5)}  中位 ${q(0.5).padStart(5)}  p90 ${q(0.9).padStart(5)}` +
        `  RS>=60 占比 ${((vals.filter((v) => v >= 60).length / vals.length) * 100).toFixed(1)}%`,
    );
  }

  for (let h = 0; h < HORIZONS.length; h += 1) {
    console.log(`\n── 前向 ${HORIZONS[h]} 日均值，同 RS 区间三方对照 ──`);
    console.log(`${"".padEnd(10)} ${"不择时".padStart(8)}   ${"朴素回踩".padStart(20)}   ${"MACD 一买".padStart(20)}`);
    for (const bucket of RS_BUCKETS) {
      const inBucket = (s: Sample) => s.rs >= bucket.lo && s.rs < bucket.hi;
      const base = meanAt(baseline.filter(inBucket), h);
      if (base == null) continue;
      console.log(
        `${bucket.label.padEnd(10)} ${`${base >= 0 ? "+" : ""}${base.toFixed(2)}%`.padStart(8)}   ` +
          `${cell(pullback.filter(inBucket), base, h)}   ` +
          `${cell(macdBuy1.filter(inBucket), base, h)}`,
      );
    }
  }

  // 全样本合计超额：各区间样本量差异很大，单看分档会被小样本区间带偏。
  for (let h = 0; h < HORIZONS.length; h += 1) {
    const base = meanAt(baseline, h)!;
    const p = meanAt(pullback, h)!;
    const m = meanAt(macdBuy1, h)!;
    console.log(
      `\n前向 ${HORIZONS[h]} 日全样本: 不择时 ${base.toFixed(2)}%  ` +
        `朴素回踩 ${p.toFixed(2)}% (${p - base >= 0 ? "+" : ""}${(p - base).toFixed(2)}pp)  ` +
        `MACD 一买 ${m.toFixed(2)}% (${m - base >= 0 ? "+" : ""}${(m - base).toFixed(2)}pp)`,
    );
  }

  await getPrisma().$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
