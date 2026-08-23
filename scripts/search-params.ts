import "dotenv/config";

import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  type BacktestConfig,
  type PreparedUniverse,
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
 * 参数网格搜索。
 *
 * 目的不是「找到最好的一组」——在给定窗口上跑一千组然后取最大值，
 * 得到的必然是好看的数字，这个数字不含信息。目的是回答三个问题：
 *
 *   1. 有没有参数组在**早期十四年**和**最近五年**同时为正？
 *   2. 「最近五年最优」那一组在早期十四年是什么表现？若为负，则它是噪声。
 *   3. 最优组周围的邻域塌不塌？真边际对 ±1 档扰动不敏感。
 *
 * 切分点固定为五年前，不参与搜索——挪窗口是又一个自由度。
 */

/** 最近五年的成交笔数下限：几十笔的样本无论多好看都是噪声。 */
const MIN_TRADES = 100;

type Row = {
  config: BacktestConfig;
  earlyExcess: number;
  recentExcess: number;
  recentTrades: number;
  recentBars: number;
  recentCagr: number;
  recentBenchCagr: number;
  recentMaxDd: number;
  recentBenchMaxDd: number;
};

/**
 * 网格。取值不是随手定的，两处刻意调整过：
 *
 * - `rpsMin` 在 20~40 之间加密。逐轴细扫显示这一段是「两窗口同时为正」的平台，
 *   原来的 0/30/50 会把整个平台跳过去，只留下平台中心一个点
 * - `trailMult` 下探到 2。原来从 3 起步，而 2~2.5 才是较优区间，
 *   也就是最优值根本不在网格里
 * - `takeProfitR` 反而收窄。逐轴细扫显示这条轴基本是平的
 *   （从不设止盈到 6R，超额都在 +4.7%~+7.3% 之间），不值得为它扩大网格
 */
function buildGrid(splitDate: string): BacktestConfig[] {
  const out: BacktestConfig[] = [];
  for (const rpsMin of [0, 20, 25, 30, 35, 40, 50]) {
    for (const stopMult of [2, 3, 4, 6]) {
      for (const trailMult of [2, 2.5, 3, 4, 6]) {
        for (const takeProfitR of [null, 2, 3]) {
          for (const [useBuy1, useBuy2] of [
            [true, true],
            [true, false],
            [false, true],
          ]) {
            out.push({
              ...DEFAULT_BACKTEST_CONFIG,
              splitDate,
              rpsMin,
              stopMult,
              trailMult,
              takeProfitR,
              useBuy1,
              useBuy2,
            });
          }
        }
      }
    }
  }
  return out;
}

function evaluate(universe: PreparedUniverse, config: BacktestConfig): Row {
  const r = runBacktest(universe, config);
  return {
    config,
    earlyExcess: r.inSample.portfolio.cagrPct - r.inSample.benchmark.cagrPct,
    recentExcess: r.outOfSample.portfolio.cagrPct - r.outOfSample.benchmark.cagrPct,
    recentTrades: r.outOfSample.trade.trades,
    recentBars: r.outOfSample.trade.avgBarsHeld,
    recentCagr: r.outOfSample.portfolio.cagrPct,
    recentBenchCagr: r.outOfSample.benchmark.cagrPct,
    recentMaxDd: r.outOfSample.portfolio.maxDrawdownPct,
    recentBenchMaxDd: r.outOfSample.benchmark.maxDrawdownPct,
  };
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

const signalLabel = (c: BacktestConfig) =>
  c.useBuy1 && c.useBuy2 ? "一+二" : c.useBuy1 ? "一买 " : "二买 ";

const describe = (c: BacktestConfig) =>
  `RPS${String(c.rpsMin).padStart(2)} 止损${c.stopMult} 吊灯${String(c.trailMult).padEnd(3)} ` +
  `止盈${(c.takeProfitR == null ? "无" : `${c.takeProfitR}R`).padEnd(2)} ${signalLabel(c)}`;

function printTable(title: string, rows: Row[]) {
  console.log(`\n${title}`);
  console.log(
    `${"参数".padEnd(38)} │ ${"早期14年".padStart(9)} │ ${"近5年".padStart(9)} ` +
      `${"笔数".padStart(5)} │ ${"近5年化".padStart(8)} ${"基准".padStart(8)} ${"回撤".padStart(7)}`,
  );
  for (const r of rows) {
    console.log(
      `${describe(r.config).padEnd(38)} │ ${pct(r.earlyExcess).padStart(9)} │ ` +
        `${pct(r.recentExcess).padStart(9)} ${String(r.recentTrades).padStart(5)} │ ` +
        `${pct(r.recentCagr).padStart(8)} ${pct(r.recentBenchCagr).padStart(8)} ` +
        `${`-${r.recentMaxDd.toFixed(0)}%`.padStart(7)}`,
    );
  }
}

/**
 * 参数稳定性：每次只动一个参数，在它的整个量程上细扫。
 *
 * 这是区分「平台」与「尖峰」的唯一办法。真的边际应该是一片连续的正区域，
 * 参数挪一两档只是量级变化；过拟合出来的最优点四周立刻转负。
 */
function stability(universe: PreparedUniverse, base: BacktestConfig) {
  const axes: { name: string; values: (number | null | boolean)[]; key: keyof BacktestConfig }[] = [
    { name: "RPS 门槛", key: "rpsMin", values: [0, 10, 20, 25, 30, 35, 40, 50, 60] },
    { name: "初始止损", key: "stopMult", values: [1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8] },
    { name: "吊灯止损", key: "trailMult", values: [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6] },
    { name: "R 倍数止盈", key: "takeProfitR", values: [null, 1, 1.5, 2, 2.5, 3, 4, 6, 10] },
    { name: "转弱离场", key: "rpsExit", values: [null, 5, 10, 15, 20, 25, 30, 40, 50] },
  ];

  console.log(`\n参数稳定性（基准组: ${describe(base)}）`);
  console.log(`每行只动一个参数，其余固定。上行为早期十四年超额，下行为最近五年超额。\n`);

  for (const axis of axes) {
    const results = axis.values.map((v) => ({
      v,
      r: evaluate(universe, { ...base, [axis.key]: v }),
    }));

    const label = (v: number | null | boolean) => (v == null ? "无" : String(v));
    console.log(
      `${axis.name.padEnd(11)} ${results.map((x) => label(x.v).padStart(8)).join("")}`,
    );
    console.log(
      `${"  早期14年".padEnd(11)} ${results.map((x) => pct(x.r.earlyExcess).padStart(8)).join("")}`,
    );
    console.log(
      `${"  近5年".padEnd(12)} ${results.map((x) => pct(x.r.recentExcess).padStart(8)).join("")}`,
    );
    console.log(
      `${"  笔数".padEnd(12)} ${results.map((x) => String(x.r.recentTrades).padStart(8)).join("")}`,
    );
    console.log(
      `${"  持仓根数".padEnd(10)} ${results.map((x) => x.r.recentBars.toFixed(0).padStart(8)).join("")}\n`,
    );
  }
}

async function main() {
  const raw = (
    process.argv.find((a) => a.startsWith("--index="))?.split("=")[1] ?? DEFAULT_INDEX
  ).toUpperCase();
  if (!(raw in INDEXES)) {
    throw new Error(`未知标的池 ${raw}，可用: ${Object.keys(INDEXES).join(", ")}`);
  }
  const index = raw as IndexKey;
  const universe = await loadPreparedUniverse(index);
  console.log(`\n标的池 ${INDEXES[index].label} (${index})   池内 ${universe.symbols.length} 只`);

  // 最近五年的起点，按日期轴上的实际交易日对齐
  const fiveYearsAgo = new Date(Date.now() - 5 * 365.25 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const splitDate = universe.axis.find((d) => d >= fiveYearsAgo) ?? fiveYearsAgo;

  // 只做稳定性检验时跳过整张网格，基准组由命令行给出
  if (process.argv.includes("--stability")) {
    stability(universe, { ...DEFAULT_BACKTEST_CONFIG, splitDate, ...parseArgs() });
    await getPrisma().$disconnect();
    return;
  }

  const grid = buildGrid(splitDate);
  console.log(
    `日期轴 ${universe.axis[0]} → ${universe.axis.at(-1)}\n` +
      `切分点 ${splitDate}（早期 = 之前十四年，近期 = 最近五年）\n` +
      `网格 ${grid.length} 组，成交笔数下限 ${MIN_TRADES}`,
  );

  const started = Date.now();
  const rows: Row[] = [];
  for (const [i, config] of grid.entries()) {
    rows.push(evaluate(universe, config));
    if ((i + 1) % 100 === 0) {
      process.stdout.write(`\r已跑 ${i + 1}/${grid.length}  ${Date.now() - started}ms   `);
    }
  }
  console.log(`\n全网格耗时 ${((Date.now() - started) / 1000).toFixed(0)}s\n`);

  const valid = rows.filter((r) => r.recentTrades >= MIN_TRADES);
  const bothPos = valid.filter((r) => r.earlyExcess > 0 && r.recentExcess > 0);
  const recentPos = valid.filter((r) => r.recentExcess > 0);

  console.log(`样本充足的组 ${valid.length}/${rows.length}`);
  console.log(`近五年超额为正 ${recentPos.length} 组 (${((recentPos.length / valid.length) * 100).toFixed(0)}%)`);
  console.log(`两窗口同时为正 ${bothPos.length} 组 (${((bothPos.length / valid.length) * 100).toFixed(0)}%)`);

  const sortedRecent = [...valid].sort((a, b) => b.recentExcess - a.recentExcess);
  const deciles = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map(
    (q) => sortedRecent[Math.min(valid.length - 1, Math.floor(q * (valid.length - 1)))],
  );
  console.log(
    `\n近五年超额分布  最好 ${pct(deciles[0].recentExcess)} / p90 ${pct(deciles[1].recentExcess)} / ` +
      `p75 ${pct(deciles[2].recentExcess)} / 中位 ${pct(deciles[3].recentExcess)} / ` +
      `p25 ${pct(deciles[4].recentExcess)} / 最差 ${pct(deciles[6].recentExcess)}`,
  );

  printTable("① 按近五年超额排序（这是最容易骗自己的一列）", sortedRecent.slice(0, 12));

  // 一致性排序：取两窗口的较小值，逼迫两边都得站得住
  const sortedConsistent = [...valid].sort(
    (a, b) => Math.min(b.earlyExcess, b.recentExcess) - Math.min(a.earlyExcess, a.recentExcess),
  );
  printTable("② 按两窗口较小值排序（要求两边都站得住）", sortedConsistent.slice(0, 12));

  stability(universe, sortedConsistent[0].config);

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
