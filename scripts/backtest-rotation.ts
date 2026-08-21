import "dotenv/config";

import { getPrisma } from "@/lib/db/prisma";
import { computeLogMacdSeries } from "@/lib/scoring/logMacd";
import { rotationRsSeries } from "@/lib/scoring/rotationRs";
import {
  computeRotationTrades,
  type ClosedTrade,
  type TradeBar,
} from "@/lib/scoring/rotationTrade";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";

/**
 * 交易层回测：带止损、吊灯、保本锁跑完整持仓周期。
 *
 * 与 calibrate-rotation 的分工：那个看的是信号后的裸前向收益，
 * 这个看的是实际按 Pine 风控执行后能落袋多少，并给 RS 闸门的取值做对照。
 */

const GATES = [0, 30, 45, 60];

type Loaded = { symbol: string; bars: TradeBar[] };

async function loadBars(): Promise<Loaded[]> {
  const prisma = getPrisma();
  const loaded: Loaded[] = [];

  for (const { symbol } of ROTATION_UNIVERSE) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) continue;
    const bars = await prisma.dailyBar.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { date: "asc" },
      select: { date: true, high: true, low: true, close: true },
    });
    if (bars.length < 400) continue;
    loaded.push({
      symbol,
      bars: bars.map((b) => ({
        date: b.date.toISOString().slice(0, 10),
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    });
  }

  return loaded;
}

function summarize(label: string, trades: ClosedTrade[]) {
  if (trades.length === 0) return `${label.padEnd(18)} 无成交`;

  const pnls = trades.map((t) => t.pnlPct);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const avg = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const sorted = [...pnls].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss === 0 ? Infinity : grossWin / grossLoss;
  const avgHold = trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length;

  return [
    label.padEnd(18),
    `${trades.length} 笔`.padStart(8),
    `胜率 ${((wins.length / pnls.length) * 100).toFixed(1)}%`.padStart(12),
    `均值 ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%`.padStart(14),
    `中位 ${median >= 0 ? "+" : ""}${median.toFixed(2)}%`.padStart(14),
    `盈亏比 ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`.padStart(13),
    `持有 ${avgHold.toFixed(0)}日`.padStart(11),
    `最差 ${sorted[0].toFixed(1)}%`.padStart(13),
  ].join("  ");
}

async function main() {
  const loaded = await loadBars();
  console.log(`标的池: ${loaded.length} 只（样本 >=400 根）\n`);

  // 信号与 RS 与闸门无关，只算一次
  const precomputed = loaded.map(({ symbol, bars }) => {
    const macd = computeLogMacdSeries(bars);
    return {
      symbol,
      bars,
      buy1: macd.map((d) => d.buy1),
      buy2: macd.map((d) => d.buy2),
      rs: rotationRsSeries(bars.map((b) => b.close)),
    };
  });

  for (const minRs of GATES) {
    const all: ClosedTrade[] = [];
    for (const p of precomputed) {
      const { closed } = computeRotationTrades(p.symbol, p.bars, p.buy1, p.buy2, p.rs, { minRs });
      all.push(...closed);
    }

    const label = minRs === 0 ? "无闸门 (Pine 原版)" : `RS >= ${minRs}`;
    console.log(`── ${label} ──`);
    console.log(summarize("全部", all));
    console.log(summarize("  ❤️ 一买", all.filter((t) => t.sigType === 1)));
    console.log(summarize("  ⭐️ 二买", all.filter((t) => t.sigType === 2)));
    console.log("");
  }

  await getPrisma().$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
