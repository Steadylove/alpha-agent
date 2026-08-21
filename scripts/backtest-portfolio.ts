import "dotenv/config";

import { getPrisma } from "@/lib/db/prisma";
import { computeLogMacdSeries } from "@/lib/scoring/logMacd";
import { macroExposurePct } from "@/lib/scoring/macroExposure";
import {
  MPR_SYMBOLS,
  alignMprInputs,
  computeMprSeries,
  type AlignBar,
  type MprSymbol,
} from "@/lib/scoring/mpr";
import { rotationRsSeries } from "@/lib/scoring/rotationRs";
import { computeRotationTrades, type TradeBar } from "@/lib/scoring/rotationTrade";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";

/**
 * 组合层回测：把 MPR 的 E_macro(Path) 敞口阶梯叠到轮动组合上，看它到底帮不帮忙。
 *
 * 与 backtest-rotation 的分工：那个按单笔交易统计，看不出敞口调节的效果
 * （敞口影响的是组合净值曲线，不是单笔盈亏）。这里逐日重建组合权益。
 *
 * 建模口径：
 *   - 每日按 RS 在持仓标的间重新分配权重（与 Pine 看板一致，隐含每日再平衡）
 *   - 空仓部分按 0 收益计（不计货币基金利息）
 *   - 不计手续费与滑点
 *
 * 防未来函数：持仓状态与 MPR 路径都用**前一交易日**的值来缩放当日收益。
 * 二者都是收盘后才能确定的（开仓价即当日收盘价，Path 依赖当日收盘），
 * 用同日值会凭空吃到触发当天的那根大阴线。
 */

const MIN_BARS = 400;
const TRADING_DAYS_PER_YEAR = 252;

type SymbolSeries = {
  symbol: string;
  dates: string[];
  closes: number[];
  inPosition: boolean[];
  rs: number[];
};

async function loadRotation(): Promise<SymbolSeries[]> {
  const prisma = getPrisma();
  const out: SymbolSeries[] = [];

  for (const { symbol } of ROTATION_UNIVERSE) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) continue;
    const rows = await prisma.dailyBar.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { date: "asc" },
      select: { date: true, high: true, low: true, close: true },
    });
    if (rows.length < MIN_BARS) continue;

    const bars: TradeBar[] = rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      high: r.high,
      low: r.low,
      close: r.close,
    }));
    const macd = computeLogMacdSeries(bars);
    const rs = rotationRsSeries(bars.map((b) => b.close));
    const { days } = computeRotationTrades(
      symbol,
      bars,
      macd.map((d) => d.buy1),
      macd.map((d) => d.buy2),
      rs,
    );

    out.push({
      symbol,
      dates: bars.map((b) => b.date),
      closes: bars.map((b) => b.close),
      inPosition: days.map((d) => d.sigType !== 0),
      rs,
    });
  }

  return out;
}

async function loadPathByDate(): Promise<Map<string, number>> {
  const prisma = getPrisma();
  const bySymbol = {} as Record<MprSymbol, AlignBar[]>;

  for (const symbol of MPR_SYMBOLS) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) throw new Error(`缺少宏观标的 ${symbol}，请先执行 npm run backfill:macro`);
    const rows = await prisma.dailyBar.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { date: "asc" },
      select: { date: true, close: true, volume: true },
    });
    bySymbol[symbol] = rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      close: r.close,
      volume: Number(r.volume),
    }));
  }

  const series = computeMprSeries(alignMprInputs(bySymbol));
  return new Map(series.map((d) => [d.date, d.pathId]));
}

type Policy = { label: string; exposureFor: (pathId: number | undefined) => number };

const POLICIES: Policy[] = [
  { label: "恒定满仓 (现状)", exposureFor: () => 1 },
  {
    label: "Pine 敞口阶梯",
    exposureFor: (p) => (p == null ? 1 : macroExposurePct(p) / 100),
  },
  {
    label: "仅 Path 4 减仓",
    exposureFor: (p) => (p === 4 ? 0.1 : 1),
  },
  {
    label: "仅 Path 2/4 减仓",
    exposureFor: (p) => (p === 4 ? 0.1 : p === 2 ? 0.4 : 1),
  },
];

function stats(dailyReturns: number[]) {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of dailyReturns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }

  const years = dailyReturns.length / TRADING_DAYS_PER_YEAR;
  const cagr = equity ** (1 / years) - 1;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (dailyReturns.length - 1);
  const vol = Math.sqrt(variance * TRADING_DAYS_PER_YEAR);
  const sharpe = vol === 0 ? 0 : (cagr / vol);

  return { equity, cagr, maxDd, vol, sharpe };
}

async function main() {
  const series = await loadRotation();
  const pathByDate = await loadPathByDate();
  console.log(`标的: ${series.length} 只   MPR 覆盖: ${pathByDate.size} 个交易日\n`);

  // 以出现过的所有交易日为轴，只统计 MPR 有覆盖的区间
  const axis = [...new Set(series.flatMap((s) => s.dates))].sort();
  const indexBySymbol = series.map((s) => new Map(s.dates.map((d, i) => [d, i])));

  const grossReturns: number[] = [];
  const paths: (number | undefined)[] = [];
  const exposureDates: string[] = [];

  const mprDates = axis.filter((d) => pathByDate.has(d));
  for (let d = 1; d < mprDates.length; d += 1) {
    const date = mprDates[d];
    const prevDate = mprDates[d - 1];

    let weightSum = 0;
    let weighted = 0;
    for (let s = 0; s < series.length; s += 1) {
      const idx = indexBySymbol[s].get(date);
      if (idx == null || idx === 0) continue;
      const sym = series[s];
      // 用前一根的持仓状态：开仓价是当根收盘价，当根的涨跌吃不到
      if (!sym.inPosition[idx - 1]) continue;

      const ret = sym.closes[idx] / sym.closes[idx - 1] - 1;
      const w = sym.rs[idx - 1];
      weighted += w * ret;
      weightSum += w;
    }

    grossReturns.push(weightSum > 0 ? weighted / weightSum : 0);
    // 敞口同样用前一日的 Path
    paths.push(pathByDate.get(prevDate));
    exposureDates.push(date);
  }

  const invested = grossReturns.filter((r) => r !== 0).length;
  console.log(
    `回测区间: ${exposureDates[0]} → ${exposureDates.at(-1)}  ` +
      `共 ${grossReturns.length} 个交易日，其中 ${invested} 日有持仓 ` +
      `(${((invested / grossReturns.length) * 100).toFixed(0)}%)\n`,
  );

  const pathDays = new Map<number, number>();
  for (const p of paths) if (p != null) pathDays.set(p, (pathDays.get(p) ?? 0) + 1);
  console.log(
    "路径分布: " +
      [...pathDays.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([p, n]) => `P${p} ${((n / paths.length) * 100).toFixed(0)}%`)
        .join("  "),
  );
  console.log(
    "平均敞口: " +
      POLICIES.map((pol) => {
        const avg = paths.reduce<number>((a, p) => a + pol.exposureFor(p), 0) / paths.length;
        return `${pol.label} ${(avg * 100).toFixed(0)}%`;
      }).join("   "),
  );
  console.log("");

  console.log(
    `${"策略".padEnd(20)}${"总倍数".padStart(10)}${"年化".padStart(10)}` +
      `${"最大回撤".padStart(12)}${"年化波动".padStart(12)}${"收益/波动".padStart(12)}`,
  );
  for (const policy of POLICIES) {
    const scaled = grossReturns.map((r, i) => r * policy.exposureFor(paths[i]));
    const s = stats(scaled);
    console.log(
      policy.label.padEnd(20) +
        `${s.equity.toFixed(2)}x`.padStart(10) +
        `${(s.cagr * 100).toFixed(2)}%`.padStart(10) +
        `${(s.maxDd * 100).toFixed(1)}%`.padStart(12) +
        `${(s.vol * 100).toFixed(1)}%`.padStart(12) +
        s.sharpe.toFixed(2).padStart(12),
    );
  }

  await getPrisma().$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
