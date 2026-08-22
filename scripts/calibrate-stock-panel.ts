import "dotenv/config";

import { getPrisma } from "@/lib/db/prisma";
import { computeDipZone } from "@/lib/scoring/dipZone";
import { relativeRsSeries } from "@/lib/scoring/relativeRs";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { atrSeries, emaSeries, smaOfNullable } from "@/lib/scoring/series";
import { computeStockRegimeSeries, type RegimeBar } from "@/lib/scoring/stockRegime";
import { computeStockStageSeries, dipStageOf, institutionalVwap } from "@/lib/scoring/stockStage";

/**
 * 在真实数据上跑一遍个股深度面板的全部引擎，产出各分类字段的分布。
 *
 * 单测多是构造出来的极端场景，只能证明公式没写错；这张表回答的是
 * 「这些分类在真实市场上到底占多大比例」——某一档常年 0% 就说明它是死代码。
 */

const BENCHMARK = "SPY";
/** EMA576 与 sma(atr,252) 的预热，之前的输出不可信。 */
const WARMUP_BARS = 900;

type Bar = RegimeBar & { date: Date };

async function loadBars(symbol: string): Promise<Bar[]> {
  const prisma = getPrisma();
  const instrument = await prisma.instrument.findUnique({ where: { symbol } });
  if (!instrument) return [];

  const rows = await prisma.dailyBar.findMany({
    where: { instrumentId: instrument.id },
    orderBy: { date: "asc" },
    select: { date: true, open: true, high: true, low: true, close: true, volume: true },
  });
  return rows.map((r) => ({
    date: r.date,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: Number(r.volume ?? 0),
  }));
}

function tally(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function printTally(title: string, counts: Map<string, number>, total: number) {
  console.log(`\n${title}`);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [key, n] of rows) {
    const pct = (n / total) * 100;
    const bar = "█".repeat(Math.round(pct / 2));
    console.log(`  ${key.padEnd(16)} ${String(n).padStart(7)}  ${pct.toFixed(2).padStart(6)}%  ${bar}`);
  }
}

async function main() {
  const benchBars = await loadBars(BENCHMARK);
  if (benchBars.length === 0) throw new Error(`基准 ${BENCHMARK} 无数据，请先回填`);
  const benchByDate = new Map(benchBars.map((b) => [b.date.getTime(), b.close]));

  const stageCounts = new Map<string, number>();
  const tierCounts = new Map<string, number>();
  const hurstCounts = new Map<string, number>();
  const hurstPriceCounts = new Map<string, number>();
  const volCounts = new Map<string, number>();
  const flowCounts = new Map<string, number>();
  const zoneCounts = new Map<string, number>();

  const rsValues: number[] = [];
  const trendValues: number[] = [];
  const hurstValues: number[] = [];
  const distValues: number[] = [];
  const depthPct: number[] = [];
  const hurstOnReturns: number[] = [];

  let total = 0;
  const skipped: string[] = [];

  for (const { symbol } of ROTATION_UNIVERSE) {
    const bars = await loadBars(symbol);
    if (bars.length < WARMUP_BARS + 100) {
      skipped.push(`${symbol}(${bars.length})`);
      continue;
    }

    // 基准必须按同一交易日轴对齐，缺失日直接丢弃该根
    const aligned = bars.filter((b) => benchByDate.has(b.date.getTime()));
    const bench = aligned.map((b) => benchByDate.get(b.date.getTime())!);
    const closes = aligned.map((b) => b.close);

    const rs = relativeRsSeries(closes, bench);
    const stages = computeStockStageSeries(aligned, rs);
    const regimes = computeStockRegimeSeries(aligned);

    const ema20 = emaSeries(closes, 20);
    const ema50 = emaSeries(closes, 50);
    const ema144 = emaSeries(closes, 144);
    const ema169 = emaSeries(closes, 169);
    const ema576 = emaSeries(closes, 576);
    const vwap90 = institutionalVwap(aligned, 90);
    const vwap250 = institutionalVwap(aligned, 250);
    const atr252 = smaOfNullable(atrSeries(aligned, 14), 252);

    for (let i = WARMUP_BARS; i < aligned.length; i += 1) {
      total += 1;
      const stage = stages[i];
      const regime = regimes[i];

      tally(stageCounts, stage.stage);
      tally(tierCounts, stage.baseTier);
      tally(hurstCounts, regime.hurstReturnRegime);
      tally(hurstPriceCounts, regime.hurstPriceRegime);
      tally(volCounts, regime.volatilityPattern);
      tally(flowCounts, regime.moneyFlow);

      rsValues.push(rs[i]);
      trendValues.push(stage.trendScore);
      hurstValues.push(regime.hurstPrice);
      hurstOnReturns.push(regime.hurstReturn);
      distValues.push(stage.distFrom52wHigh);

      const zone = computeDipZone({
        close: aligned[i].close,
        atr: atr252[i] ?? 0,
        stage: dipStageOf(stage.flags),
        trendScore: stage.trendScore,
        volumeRatio: regime.volumeRatio,
        pathId: 0,
        ema20: ema20[i],
        ema50: ema50[i],
        ema576: ema576[i],
        vwap90: vwap90[i],
        vwap250: vwap250[i],
        ema144: ema144[i],
        ema169: ema169[i],
      });
      tally(zoneCounts, zone.kind === "range" ? `range:${zone.quality}` : zone.kind);
      if (zone.kind === "range") {
        depthPct.push(((aligned[i].close - zone.low) / aligned[i].close) * 100);
      }
    }
  }

  console.log(`样本 ${total} 个 bar-day，跳过 ${skipped.length} 只：${skipped.join(", ") || "无"}`);

  printTally("形态阶段分布", stageCounts, total);
  printTally("筑底档位分布", tierCounts, total);
  printTally("Hurst 态别分布（收益率口径，面板采用）", hurstCounts, total);
  printTally("Hurst 态别分布（价格口径，Pine 原样）", hurstPriceCounts, total);
  printTally("波动形态分布", volCounts, total);
  printTally("资金态分布", flowCounts, total);
  printTally("低吸带类型分布", zoneCounts, total);

  console.log("\n连续量分位（p5 / p25 / p50 / p75 / p95）");
  for (const [label, arr] of [
    ["RS 评分", rsValues],
    ["趋势分", trendValues],
    ["Hurst 价格口径", hurstValues],
    ["Hurst 收益口径", hurstOnReturns],
    ["距 52 周高 %", distValues],
    ["低吸带深度 %", depthPct],
  ] as const) {
    const s = [...arr].sort((a, b) => a - b);
    const q = (p: number) => s[Math.floor((s.length - 1) * p)];
    console.log(
      `  ${label.padEnd(14)} ${[0.05, 0.25, 0.5, 0.75, 0.95]
        .map((p) => q(p).toFixed(2).padStart(9))
        .join("")}`,
    );
  }

  const maxDist = distValues.reduce((a, b) => Math.max(a, b), -Infinity);
  console.log(
    `\n距 52 周高的历史最大值 ${maxDist.toFixed(2)}%，Stage C 门槛 18%，` +
      `触发 ${stageCounts.get("C") ?? 0} / ${total} 次`,
  );

  // Hurst 对照：Pine 把 R/S 直接套在收盘价上，而 R/S 的定义要求作用在增量序列上。
  // 价格本身是累积量，自带趋势，因此 H 会被系统性推高。
  const h = [...hurstValues].sort((a, b) => a - b);
  const hRet = [...hurstOnReturns].sort((a, b) => a - b);
  const q = (s: number[], p: number) => s[Math.floor((s.length - 1) * p)];
  console.log(
    `\nHurst 口径对照（p5/p50/p95）\n` +
      `  作用于收盘价（Pine 原样）  ${q(h, 0.05).toFixed(3)} / ${q(h, 0.5).toFixed(3)} / ${q(h, 0.95).toFixed(3)}\n` +
      `  作用于日收益率（教科书）  ${q(hRet, 0.05).toFixed(3)} / ${q(hRet, 0.5).toFixed(3)} / ${q(hRet, 0.95).toFixed(3)}`,
  );
}
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrisma().$disconnect();
  });
