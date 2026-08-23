import "dotenv/config";

import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  type BacktestConfig,
  type PreparedUniverse,
  type WindowResult,
} from "@/lib/backtest/engine";
import {
  DEFAULT_INDEX,
  INDEXES,
  loadPreparedUniverse,
  type IndexKey,
} from "@/lib/backtest/load";
import { getPrisma } from "@/lib/db/prisma";

import { parseArgs } from "./backtest-args";

/**
 * 调参回测的命令行入口，与 /lab 页面共用同一个引擎。
 *
 * 用法: npm run lab -- --rpsMin=80 --takeProfitR=3 --stopMult=3
 */


const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

function printWindow(w: WindowResult) {
  const { trade: t, portfolio: p, benchmark: b } = w;
  console.log(`\n【${w.label}】${w.from} → ${w.to}  (${p.days} 个交易日)`);
  console.log(
    `  成交 ${t.trades} 笔   胜率 ${t.winRatePct.toFixed(1)}%   ` +
      `均值 ${pct(t.meanPnlPct)}   中位 ${pct(t.medianPnlPct)}   ` +
      `盈亏比 ${t.profitFactor.toFixed(2)}`,
  );
  console.log(
    `  平均 ${t.avgBarsHeld.toFixed(0)} 根   最差 ${pct(t.worstPnlPct)}   ` +
      `平均 R ${t.meanR.toFixed(2)}   离场 止损${t.exits.stop}/止盈${t.exits.target}`,
  );
  console.log(
    `  组合  净值 ${p.equity.toFixed(2)}x  年化 ${pct(p.cagrPct)}  ` +
      `回撤 -${p.maxDrawdownPct.toFixed(1)}%  波动 ${p.volPct.toFixed(1)}%  ` +
      `持仓日 ${p.investedDayPct.toFixed(0)}%  敞口 ${p.avgExposurePct.toFixed(0)}%`,
  );
  console.log(
    `  基准  净值 ${b.equity.toFixed(2)}x  年化 ${pct(b.cagrPct)}  ` +
      `回撤 -${b.maxDrawdownPct.toFixed(1)}%  波动 ${b.volPct.toFixed(1)}%`,
  );
  console.log(`  超额  年化 ${pct(p.cagrPct - b.cagrPct)}`);
}

/** 截面 RPS 的自检：抽一天，看分位是否铺满 1~99 且只含当日成分。 */
function verifyCrossSection(universe: PreparedUniverse, date: string) {
  const d = universe.axis.indexOf(date);
  if (d < 0) {
    console.log(`\n[自检] ${date} 不在日期轴上，跳过`);
    return;
  }

  const ranked: number[] = [];
  let nonMemberRanked = 0;
  for (const sym of universe.symbols) {
    const i = sym.axisIndex.indexOf(d);
    if (i < 0) continue;
    if (sym.rps[i] > 0) {
      ranked.push(sym.rps[i]);
      if (sym.isMember[i] === 0) nonMemberRanked += 1;
    }
  }
  ranked.sort((a, b) => a - b);

  const q = (f: number) => ranked[Math.floor(f * (ranked.length - 1))]?.toFixed(1);
  console.log(
    `\n[自检] ${date} 参与截面 ${ranked.length} 只   ` +
      `分位 min ${q(0)} / p25 ${q(0.25)} / 中位 ${q(0.5)} / p75 ${q(0.75)} / max ${q(1)}   ` +
      `非成分被排名 ${nonMemberRanked} 只 ${nonMemberRanked === 0 ? "✓" : "✗"}`,
  );
}

/**
 * 参数扫描：同一进程内跑完整个网格，训练区与保留区并排输出。
 *
 * 并排是刻意的——只看训练区挑最优就是在拟合噪声。网格里试了多少组，
 * 「最优」那组的训练区超额就有多少次机会来自偶然。
 */
function sweep(universe: PreparedUniverse, base: BacktestConfig) {
  const grid: Partial<BacktestConfig>[] = [];
  for (const rpsMin of [0, 50, 70, 80, 90]) {
    for (const takeProfitR of [null, 1, 2, 3]) {
      grid.push({ rpsMin, takeProfitR });
    }
  }

  console.log(`\n参数扫描  共 ${grid.length} 组`);
  console.log(
    `${"RPS".padStart(4)} ${"止盈".padStart(5)} │ ` +
      `${"训练超额".padStart(9)} ${"笔数".padStart(6)} │ ` +
      `${"保留超额".padStart(9)} ${"笔数".padStart(6)} │ 一致`,
  );

  for (const cell of grid) {
    const r = runBacktest(universe, { ...base, ...cell });
    const inEx = r.inSample.portfolio.cagrPct - r.inSample.benchmark.cagrPct;
    const outEx = r.outOfSample.portfolio.cagrPct - r.outOfSample.benchmark.cagrPct;
    const agree = inEx > 0 && outEx > 0 ? "✓" : inEx > 0 || outEx > 0 ? "半" : "✗";

    console.log(
      `${String(cell.rpsMin).padStart(4)} ${(cell.takeProfitR == null ? "无" : `${cell.takeProfitR}R`).padStart(5)} │ ` +
        `${pct(inEx).padStart(9)} ${String(r.inSample.trade.trades).padStart(6)} │ ` +
        `${pct(outEx).padStart(9)} ${String(r.outOfSample.trade.trades).padStart(6)} │ ${agree}`,
    );
  }
}

/** `--index=NDX100` 切换标的池，默认标普。 */
function parseIndexArg(): IndexKey {
  const raw = (
    process.argv.find((a) => a.startsWith("--index="))?.split("=")[1] ?? DEFAULT_INDEX
  ).toUpperCase();
  if (!(raw in INDEXES)) {
    throw new Error(`未知标的池 ${raw}，可用: ${Object.keys(INDEXES).join(", ")}`);
  }
  return raw as IndexKey;
}

async function main() {
  const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...parseArgs() };
  const index = parseIndexArg();

  let t = Date.now();
  const universe = await loadPreparedUniverse(index);
  const prepMs = Date.now() - t;

  t = Date.now();
  const result = runBacktest(universe, config);
  const runMs = Date.now() - t;

  console.log(
    `\n标的池 ${INDEXES[index].label} (${index})   准备 ${prepMs}ms   回测 ${runMs}ms   ` +
      `池内 ${result.universeSize} 只   日期轴 ${universe.axis.length} 天   ` +
      `采纳信号 ${result.signalCount} 个`,
  );
  console.log(
    `参数  RPS>=${config.rpsMin}  止损 ${config.stopMult}×ATR  吊灯 ${config.trailMult}×ATR  ` +
      `止盈 ${config.takeProfitR == null ? "无" : `${config.takeProfitR}R`}  ` +
      `信号 ${[config.useBuy1 && "一买", config.useBuy2 && "二买"].filter(Boolean).join("+") || "无"}`,
  );
  console.log(
    `初筛  成交额 ${config.minAdtvUsd > 0 ? `>=$${(config.minAdtvUsd / 1e6).toFixed(0)}M/日` : "不筛"}  ` +
      `价格 ${config.minPrice > 0 ? `>=$${config.minPrice}` : "不筛"}  ` +
      `趋势 ${config.requireTrend ? "须站上 MA200 或 MA850" : "不筛"}`,
  );

  verifyCrossSection(universe, "2015-06-30");

  if (process.argv.includes("--sweep")) {
    sweep(universe, config);
    await getPrisma().$disconnect();
    return;
  }

  printWindow(result.inSample);
  printWindow(result.outOfSample);

  console.log(`\n分年度 (策略 / 同池基准，* 为保留区)`);
  for (const y of result.byYear) {
    const flag = y.isOutOfSample ? "*" : " ";
    console.log(
      `  ${y.year}${flag}  ${pct(y.strategyPct).padStart(9)}  ${pct(y.benchmarkPct).padStart(9)}` +
        `   超额 ${pct(y.strategyPct - y.benchmarkPct).padStart(9)}   ${y.trades} 笔`,
    );
  }

  await getPrisma().$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await getPrisma().$disconnect();
  } catch {
    // Prisma 初始化前就失败
  }
  process.exit(1);
});
