import "dotenv/config";

import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  runSymbol,
  windowBounds,
  type BacktestConfig,
  type PreparedUniverse,
} from "@/lib/backtest/engine";
import { loadPreparedUniverse, smallFundSource } from "@/lib/backtest/load";
import {
  SMALL_FUND_DEFAULT_CONFIG,
  SMALL_FUND_UNIVERSE,
} from "@/lib/backtest/smallFundUniverse";

/**
 * Small Fund 第一步诊断：并发持仓够不够做「按 RPS 分配」。
 *
 * 四组：裸信号 / +RSI / +Vegas / 两者都开。权重一律等权，避免混进分配效应。
 *
 * 用法: npm run smallfund:diag
 */

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] * (hi - i) + sorted[hi] * (i - lo);
}

function concurrentCounts(universe: PreparedUniverse, config: BacktestConfig): Int32Array {
  const { lo, hi } = windowBounds(universe.axis, config);
  const counts = new Int32Array(Math.max(0, hi - lo));
  for (const sym of universe.symbols) {
    const { days } = runSymbol(universe.axis, sym, config, lo, hi);
    for (let i = 0; i < days.length; i += 1) {
      if (days[i].sigType === 0) continue;
      const d = sym.axisIndex[i] - lo;
      if (d >= 0 && d < counts.length) counts[d] += 1;
    }
  }
  return counts;
}

function summarize(label: string, universe: PreparedUniverse, override: Partial<BacktestConfig>) {
  const config: BacktestConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    ...SMALL_FUND_DEFAULT_CONFIG,
    requireRsi: false,
    requireVegas: false,
    rpsWeightPower: null,
    ...override,
  };

  const result = runBacktest(universe, config);
  const counts = Array.from(concurrentCounts(universe, config));
  const sorted = [...counts].sort((a, b) => a - b);
  const zero = counts.filter((n) => n === 0).length;
  const w = result.inSample;

  console.log(`\n【${label}】`);
  console.log(
    `  信号 ${result.signalCount}  成交 ${w.trade.trades} 笔  ` +
      `年化 ${pct(w.portfolio.cagrPct)}  基准 ${pct(w.benchmark.cagrPct)}  ` +
      `超额 ${pct(w.portfolio.cagrPct - w.benchmark.cagrPct)}  ` +
      `回撤 -${w.portfolio.maxDrawdownPct.toFixed(1)}%  ` +
      `持仓日 ${w.portfolio.investedDayPct.toFixed(0)}%`,
  );
  console.log(
    `  并发  中位 ${quantile(sorted, 0.5).toFixed(1)}  ` +
      `p25 ${quantile(sorted, 0.25).toFixed(1)}  ` +
      `p75 ${quantile(sorted, 0.75).toFixed(1)}  ` +
      `最大 ${sorted[sorted.length - 1] ?? 0}  ` +
      `空仓日 ${zero}/${counts.length} (${((zero / Math.max(counts.length, 1)) * 100).toFixed(0)}%)`,
  );
  return { median: quantile(sorted, 0.5), trades: w.trade.trades };
}

async function main() {
  const t0 = Date.now();
  const universe = await loadPreparedUniverse("SMALLFUND");
  const listed = new Set(SMALL_FUND_UNIVERSE);
  const missing = SMALL_FUND_UNIVERSE.filter(
    (t) => !universe.symbols.some((s) => s.ticker === t),
  );

  console.log(
    `Small Fund 诊断  源=${smallFundSource()}  池内 ${universe.symbols.length}/${listed.size} 只  ` +
      `日期轴 ${universe.axis.length} 天  窗口 ${SMALL_FUND_DEFAULT_CONFIG.from} → ${SMALL_FUND_DEFAULT_CONFIG.to}  ` +
      `准备 ${Date.now() - t0}ms`,
  );
  if (missing.length > 0) {
    console.log(`缺文件/未入池: ${missing.join(", ")}`);
  }

  const bare = summarize("裸信号（RSI/Vegas 关，RPS 不定权）", universe, {});
  summarize("只开 RSI>30", universe, { requireRsi: true, minRsi: 30 });
  summarize("只开 Vegas", universe, { requireVegas: true });
  const both = summarize("RSI + Vegas（策略默认闸门）", universe, {
    requireRsi: true,
    minRsi: 30,
    requireVegas: true,
  });

  console.log("\n分叉:");
  if (both.median < 4) {
    console.log(
      `  默认闸门下并发中位 ${both.median.toFixed(1)} < 4，「按 RPS 分配」几乎无事可分。` +
        `裸信号中位 ${bare.median.toFixed(1)}。先看哪道闸门砍得最狠，再决定要不要放宽 Vegas 周期或开二买。`,
    );
  } else {
    console.log(
      `  默认闸门下并发中位 ${both.median.toFixed(1)}，够做相对定权。下一步扫 k ∈ {0, 0.5, 1, 2, 3}。`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
