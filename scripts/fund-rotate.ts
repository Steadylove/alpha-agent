import { readFileSync } from "node:fs";

import {
  barsPerYearOf,
  DEFAULT_BACKTEST_CONFIG,
  prepareSymbolInputs,
  runBacktest,
  tradeParamsOf,
  windowBounds,
  type BacktestConfig,
  type PreparedUniverse,
  type Timeframe,
} from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import {
  SMALL_FUND_4H_DEFAULT_CONFIG,
  SMALL_FUND_DEFAULT_CONFIG,
} from "@/lib/backtest/smallFundUniverse";
import { rotationTradeSteps, type StepDecision, type StepView } from "@/lib/scoring/rotationTrade";

/**
 * 现金账本口径下的回测与网格。冻结档数字只从这里复现。
 *
 * 与实验室 `runBacktest` 的权重法不同：每笔固定投当时权益的 `slotPct`，现金不够
 * 就开不了仓。权重法靠逐根把持仓拉回等权、开新仓时按比例摊薄旧仓，敞口永远贴满
 * ——真实账户没有「按比例摊薄」这个操作，所以那条曲线照着下不了单。
 *
 *   npx --yes tsx scripts/fund-rotate.ts <1d|4h|2h|1h> <part> [costBps]
 *
 * 4H 冻结档：止 8 / 吊 10 / 无盈 / 门 0 / 每笔 8% / 入收盘 / RSI≥30 / 不置换。
 */

/** `none` = 满仓就放弃；`weakest`/`random` 只差挑谁当受害者，用来隔离「挑最弱」的贡献。 */
type Mode = "none" | "weakest" | "random";

export type Opts = {
  slotPct: number;
  mode: Mode;
  /** 新信号要强出多少分才值得置换。0 = 只要更强就换；-Infinity = 无条件换。 */
  edge: number;
  costBps: number;
  seed?: number;
  /**
   * 入场决策允许发生在哪些根上。
   *
   * `all` 是回测的理想口径：4H 每根收盘都能下单。但盘中那根收在美东 13:30，
   * 而它的收盘价同时是下一根的开盘价——照这个口径执行等于要在北京时间凌晨
   * 两点半的同一秒成交。`dayClose` 只认美东收盘那根，次日开盘成交，代价是
   * 丢掉盘中那根的全部信号。
   */
  entryWindow?: "all" | "dayClose";
  /**
   * 多周期嵌套用的入场闸门：给定标的与当根日期，返回是否允许开仓。
   * 走的是组合层的 rejectEntry 通道，所以状态机不会偷跑建仓。
   */
  entryGate?: (ticker: string, date: string) => boolean;
  /** 按日期给出单笔比例，用来做市场状态依赖的仓位调节。返回 0 表示当根停手。 */
  slotPctOf?: (date: string) => number;
  /** 单票层面的仓位缩放系数，乘在当根的单笔金额上。 */
  slotScale?: (ticker: string, date: string) => number;
  /**
   * 反向嵌套：入场信号改由日线提供（ticker → 有买点的日期集合），
   * 只在当天最后一根落地；ATR / 吊灯 / 破位判定仍跑在本周期上，即「慢进快出」。
   */
  dailyEntry?: Map<string, Set<string>>;
  /**
   * 出场决策允许发生在哪些根上。`dayClose` = 只在美东收盘那根判破位、次日开盘
   * 市价单成交，代价是止损慢半天。`all`（默认）是回测原口径，实盘需要挂条件单
   * 或凌晨盯盘才能复现。
   */
  exitWindow?: "all" | "dayClose";
};

type Result = {
  cagr: number;
  dd: number;
  mar: number;
  entries: number;
  rotations: number;
  missed: number;
  avgHoldings: number;
  avgExposure: number;
  /** 年均成交笔数（开仓 + 平仓） */
  tradesPerYear: number;
  lotPnl: { symbol: string; pct: number }[];
  curve: { date: string; v: number }[];
  /** 每根的持仓只数，用来看分布而不只是均值 */
  holdCounts: number[];
};

function statsOf(equity: number[], bpy: number) {
  const n = equity.length;
  let peak = equity[0] ?? 1;
  let maxDd = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, 1 - v / peak);
  }
  const years = n / bpy;
  const cagr = years > 0 ? ((equity[n - 1] ?? 1) ** (1 / years) - 1) * 100 : 0;
  const dd = maxDd * 100;
  return { cagr, dd, mar: dd > 0 ? cagr / dd : 0 };
}

export function runRotate(uni: PreparedUniverse, config: BacktestConfig, opts: Opts): Result {
  const { lo, hi } = windowBounds(uni.axis, config);
  const cost = opts.costBps / 10_000;
  // 当天最后一根：下一根的日期变了。日线下恒为 true，两个窗口选项因此对日线无副作用
  const isDayClose = uni.axis.map(
    (a, i) => i + 1 >= uni.axis.length || uni.axis[i + 1].slice(0, 10) !== a.slice(0, 10),
  );

  const legs = uni.symbols.map((sym, idx) => {
    const inp = prepareSymbolInputs(uni.axis, sym, config, lo, hi);
    if (opts.dailyEntry) {
      const days = opts.dailyEntry.get(sym.ticker);
      for (let k = 0; k < inp.buy1.length; k += 1) {
        const gi = sym.axisIndex[k];
        inp.buy1[k] = isDayClose[gi] && !!days?.has(uni.axis[gi].slice(0, 10));
        inp.buy2[k] = false;
      }
    }
    return {
      idx,
      sym,
      gen: rotationTradeSteps(
        sym.ticker,
        inp.bars,
        inp.buy1,
        inp.buy2,
        inp.rs,
        // 出场闸门按本票自己的轴对齐：inp.bars 的第 k 根对应全局 axisIndex[k]
        {
          ...tradeParamsOf(config),
          ...(opts.exitWindow === "dayClose"
            ? { exitGate: (k: number) => isDayClose[sym.axisIndex[k]] }
            : {}),
        },
      ),
      cursor: 0,
      local: -1,
      view: null as StepView | null,
      lastClose: 0,
      lastRps: 0,
    };
  });

  /** 最后一根落在回测收尾之前的 leg，只有这些需要逐根判断断裂清算。 */
  const staleLegs = legs
    .map((leg) => ({ leg, end: leg.sym.axisIndex[leg.sym.axisIndex.length - 1] }))
    .filter(({ end }) => end < hi - 1);

  let cash = 1;
  const slots = new Map<number, { shares: number; cost: number; eqAtEntry: number }>();
  /** 每笔平仓相对开仓时权益的贡献率（%），用于查收益是否靠少数几笔撑起来 */
  const lotPnl: { symbol: string; pct: number }[] = [];
  let orders: { idx: number; amount: number }[] = [];
  const decisions = new Map<number, StepDecision>();

  const equity: number[] = [];
  const curve: { date: string; v: number }[] = [];
  const holdCounts: number[] = [];
  let entries = 0;
  let rotations = 0;
  let missed = 0;
  let holdingSum = 0;
  let exposureSum = 0;
  let exits = 0;

  let lastEq = 1;
  let seed = opts.seed ?? 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  // 从轴首推进：状态机要窗口前的 ATR 预热，组合层只在窗口内活动
  for (let d = 0; d < hi; d += 1) {
    for (const leg of legs) {
      if (leg.cursor < leg.sym.axisIndex.length && leg.sym.axisIndex[leg.cursor] === d) {
        const r = leg.gen.next(decisions.get(leg.idx));
        leg.view = r.done ? null : r.value;
        leg.local = leg.cursor;
        leg.cursor += 1;
        leg.lastClose = leg.sym.close[leg.local];
        if (leg.sym.rps[leg.local] >= 1) leg.lastRps = leg.sym.rps[leg.local];
      } else {
        leg.view = null;
      }
    }
    decisions.clear();
    if (d < lo) continue;

    // 开盘先平：置换腾出的现金同根就能用于建仓
    for (const leg of legs) {
      const done = leg.view?.justClosed;
      if (!done) continue;
      const slot = slots.get(leg.idx);
      if (!slot) continue;
      const proceeds = slot.shares * done.exitPrice * (1 - cost);
      cash += proceeds;
      exits += 1;
      if (slot.eqAtEntry > 0) {
        lotPnl.push({
          symbol: leg.sym.ticker,
          pct: ((proceeds - slot.cost) / slot.eqAtEntry) * 100,
        });
      }
      slots.delete(leg.idx);
    }

    // 数据断裂清算：某票在窗口内就没有后续 bar 了（退市、被收购、换代码，Alpaca 侧
    // 同样查无数据）。不清算的话状态机再不推进，这笔既不触发出场也不再变价，会冻结
    // 在最后收盘价上占着槽位直到回测结束。
    // 只遍历预先筛出的断裂 leg：全池扫一遍是 O(根数 × 195)，1H 上 576 组要多跑
    // 8 亿次迭代，而实际会断的只有个位数只票。
    for (const { leg, end } of staleLegs) {
      if (d <= end) continue;
      const slot = slots.get(leg.idx);
      if (!slot) continue;
      const proceeds = slot.shares * leg.lastClose * (1 - cost);
      cash += proceeds;
      exits += 1;
      if (slot.eqAtEntry > 0) {
        lotPnl.push({
          symbol: leg.sym.ticker,
          pct: ((proceeds - slot.cost) / slot.eqAtEntry) * 100,
        });
      }
      slots.delete(leg.idx);
    }

    for (const leg of legs) {
      if (!leg.view?.day.entered) continue;
      const order = orders.find((o) => o.idx === leg.idx);
      const price = leg.view.day.entryPrice;
      if (!order || price == null || price <= 0) continue;
      // 受害者的平仓额可能不及预期，按实际现金截断
      const amount = Math.min(order.amount, cash);
      if (amount <= 1e-9) continue;
      slots.set(leg.idx, {
        shares: (amount * (1 - cost)) / price,
        cost: amount,
        eqAtEntry: lastEq,
      });
      cash -= amount;
      entries += 1;
    }
    orders = [];

    let held = 0;
    for (const [idx, slot] of slots) held += slot.shares * legs[idx].lastClose;
    const eq = cash + held;
    lastEq = eq;
    equity.push(eq);
    curve.push({ date: uni.axis[d], v: eq });
    holdingSum += slots.size;
    holdCounts.push(slots.size);
    exposureSum += eq > 0 ? (held / eq) * 100 : 0;

    // 收盘定策：强的先挑
    const fresh = legs
      .filter((leg) => leg.view != null && leg.view.pendingEntry !== 0)
      .map((leg) => ({ leg, rps: leg.lastRps }))
      .sort((a, b) => b.rps - a.rps);
    if (fresh.length === 0) continue;

    if (opts.entryGate) {
      const date = uni.axis[d];
      for (const cand of fresh) {
        if (!opts.entryGate(cand.leg.sym.ticker, date)) {
          decisions.set(cand.leg.idx, { rejectEntry: true });
          missed += 1;
        }
      }
    }

    if (opts.entryWindow === "dayClose" && !isDayClose[d]) {
      // 人不在场，这根的信号只能作废。不显式拒绝的话状态机会照原价建仓，等于偷跑
      for (const cand of fresh) {
        decisions.set(cand.leg.idx, { rejectEntry: true });
        missed += 1;
      }
      continue;
    }

    const curDate = uni.axis[d];
    const slotAmount = eq * (opts.slotPctOf ? opts.slotPctOf(curDate) : opts.slotPct);
    let free = cash;
    const doomed = new Set<number>();

    for (const cand of fresh) {
      if (decisions.get(cand.leg.idx)?.rejectEntry) continue;
      const want = slotAmount * (opts.slotScale?.(cand.leg.sym.ticker, curDate) ?? 1);
      if (want <= 1e-9) {
        // 停手档：不显式拒绝，状态机会照原价建仓
        decisions.set(cand.leg.idx, { rejectEntry: true });
        missed += 1;
        continue;
      }
      if (free >= want) {
        orders.push({ idx: cand.leg.idx, amount: want });
        free -= want;
        continue;
      }

      const alive = [...slots.keys()].filter((i) => !doomed.has(i));
      if (opts.mode === "none" || alive.length === 0) {
        decisions.set(cand.leg.idx, { rejectEntry: true });
        missed += 1;
        continue;
      }

      const victim =
        opts.mode === "random"
          ? alive[Math.floor(rnd() * alive.length)]
          : alive.reduce((a, b) => (legs[a].lastRps <= legs[b].lastRps ? a : b));

      if (cand.rps > legs[victim].lastRps + opts.edge) {
        decisions.set(victim, { forceExit: true });
        doomed.add(victim);
        orders.push({ idx: cand.leg.idx, amount: slotAmount });
        // 受害者下一根开盘平仓，钱同根到账，故计入当根可用
        const victimValue = slots.get(victim)!.shares * legs[victim].lastClose;
        free += victimValue * (1 - cost) - slotAmount;
        rotations += 1;
      } else {
        decisions.set(cand.leg.idx, { rejectEntry: true });
        missed += 1;
      }
    }
  }

  const n = Math.max(1, equity.length);
  // 日频口径：每个交易日取收盘净值再按 252 折年，不用 barsPerYear 常量。
  // 常量靠不住——2H 实测 3.52 根/天而常量按 3 算，年化被压低 15%；日频还让四个
  // 周期与 SPY/QQQ 基准同采样频率，回撤深度因此可比（bar 级采样越密回撤越深）。
  const byDay = new Map<string, number>();
  for (const pt of curve) byDay.set(pt.date.slice(0, 10), pt.v);
  const dailyEq = [...byDay.keys()].sort().map((k) => byDay.get(k)!);
  const s = statsOf(dailyEq, 252);
  const years = dailyEq.length / 252;
  return {
    ...s,
    entries,
    rotations,
    missed,
    avgHoldings: holdingSum / n,
    avgExposure: exposureSum / n,
    tradesPerYear: years > 0 ? (entries + exits) / years : 0,
    lotPnl,
    curve,
    holdCounts,
  };
}

const SEGMENTS = [
  { label: "前半", from: "2021-08-24", to: "2024-02-24" },
  { label: "后半", from: "2024-02-24", to: "2026-08-24" },
  { label: "全段", from: "2021-08-24", to: "2026-08-24" },
];

/** 两段都要过关：收益取更低的一段、回撤取更大的一段，不许互相掩护。 */
const worst = (rs: { cagr: number; dd: number }[]) => {
  const cagr = Math.min(...rs.map((r) => r.cagr));
  const dd = Math.max(...rs.map((r) => r.dd));
  return { cagr, dd, mar: dd > 0 ? cagr / dd : 0 };
};

const cell = (r: { cagr: number; dd: number; mar: number }) =>
  `${r.cagr.toFixed(1)}/${r.dd.toFixed(0)}/${r.mar.toFixed(2)}`;

function baseOf(tf: Timeframe) {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    ...(tf === "1d" ? SMALL_FUND_DEFAULT_CONFIG : SMALL_FUND_4H_DEFAULT_CONFIG),
    // 4H 冻结档的门槛 50 是在旧 RPS 口径上调出来的，新口径下重搜是 30
    ...(tf === "1d" ? {} : { rpsMin: 30 }),
  };
}

/**
 * 指数买入持有基准。
 *
 * 引擎 book 里的 `spy` 恒为 null（SPY 不是任何指数成分，被池子自然排除），所以直接
 * 读 CSV。这是唯一一条**没有生存偏差**的基准：池子是 2026 年选的，池内基准无论怎么
 * 算都带后见之明，而「当年就买指数」是当时真做得到的选择。
 */
function csvBuyHold(file: string, from: string, to: string) {
  // 读的是日线 CSV，年化基数固定 252。跟着回测周期走会把 4H 档的指数年化算成两倍。
  const bpy = 252;
  const lines = readFileSync(file, "utf8").trim().split("\n").slice(1);
  const eq: number[] = [];
  for (const line of lines) {
    const [date, , , , close] = line.split(",");
    const day = date.slice(0, 10);
    if (day < from || day > to) continue;
    const v = Number(close);
    if (Number.isFinite(v) && v > 0) eq.push(v);
  }
  if (eq.length < 2) return null;
  const base = eq[0];
  return statsOf(
    eq.map((v) => v / base),
    bpy,
  );
}

async function main() {
  const tfArg = process.argv[2] ?? "1d";
  // 传错周期会静默回退到日线，把「4H 的结果」和日线搞混过一次，这里直接拦住。
  if (!["1d", "4h", "2h", "1h"].includes(tfArg)) {
    throw new Error(`未知周期 ${tfArg}。用法：fund-rotate.ts <1d|4h|2h|1h> <part> [costBps]`);
  }
  const tf = tfArg as Timeframe;
  const part = process.argv[3] ?? "grid";
  const costBps = Number(process.argv[4] ?? 10);
  const base = baseOf(tf);
  const uni = await getPreparedUniverse("SMALLFUND", tf);
  const bpy = barsPerYearOf(tf);
  const cfgOf = (i: number) =>
    ({ ...base, from: SEGMENTS[i].from, to: SEGMENTS[i].to, timeframe: tf }) as BacktestConfig;

  if (part === "bench" || part === "grid") {
    console.log(`\n=== ${tf} 基准线（CAGR / 回撤 / MAR）===`);
    console.log("口径".padEnd(22) + SEGMENTS.map((s) => s.label.padStart(18)).join("") + "  取差者");
    const rows: Record<string, { cagr: number; dd: number }[]> = {
      "权重法（引擎默认）": [],
      "池内每根等权": [],
      "池内买入持有": [],
      "SPY 买入持有": [],
      "QQQ 买入持有": [],
    };
    for (let i = 0; i < SEGMENTS.length; i += 1) {
      const seg = SEGMENTS[i];
      const r = runBacktest(uni, cfgOf(i));
      const w = r.inSample;
      rows["权重法（引擎默认）"].push({ cagr: w.portfolio.cagrPct, dd: w.portfolio.maxDrawdownPct });
      rows["池内每根等权"].push({ cagr: w.benchmark.cagrPct, dd: w.benchmark.maxDrawdownPct });
      if (w.buyHold) rows["池内买入持有"].push({ cagr: w.buyHold.cagrPct, dd: w.buyHold.maxDrawdownPct });
      const spy = csvBuyHold("data/benchmarks/SPY.csv", seg.from, seg.to);
      if (spy) rows["SPY 买入持有"].push(spy);
      const qqq = csvBuyHold("data/smallfund/QQQ.csv", seg.from, seg.to);
      if (qqq) rows["QQQ 买入持有"].push(qqq);
    }
    for (const [label, rs] of Object.entries(rows)) {
      if (rs.length === 0) continue;
      const cells = rs
        .map((r) => cell({ ...r, mar: r.dd > 0 ? r.cagr / r.dd : 0 }).padStart(18))
        .join("");
      // 取差者只看前两段，全段不参与（它是前两段的合成）
      console.log(label.padEnd(22) + cells + "  " + cell(worst(rs.slice(0, 2))));
    }
  }

  if (part === "grid") {
    const slots = [0.06, 0.08, 0.1, 0.125, 0.15, 0.2, 0.25];
    const edges: (number | "none")[] = ["none", -Infinity, 0, 10, 15, 20, 25, 30];
    console.log(`\n=== ${tf} 现金账本：每笔比例 × 置换门槛（成本 ${costBps}bps，两段取差者）===`);
    console.log(
      "每笔".padEnd(7) +
        edges
          .map((e) => (e === "none" ? "不置换" : e === -Infinity ? "无条件" : `+${e}`).padStart(17))
          .join(""),
    );
    const best: { key: string; cagr: number; dd: number; mar: number }[] = [];
    for (const slotPct of slots) {
      const cells: string[] = [];
      for (const e of edges) {
        const mode: Mode = e === "none" ? "none" : "weakest";
        const edge = e === "none" ? 0 : e;
        const rs = [0, 1].map((i) =>
          runRotate(uni, cfgOf(i), { slotPct, mode, edge, costBps }),
        );
        const w = worst(rs);
        best.push({ key: `${(slotPct * 100).toFixed(1)}%|${e === "none" ? "不置换" : e === -Infinity ? "无条件" : `+${e}`}`, ...w });
        cells.push(cell(w).padStart(17));
      }
      console.log(`${(slotPct * 100).toFixed(1)}%`.padEnd(7) + cells.join(""));
    }
    best.sort((a, b) => b.mar - a.mar);
    console.log(`\n--- ${tf} MAR 前 10 ---`);
    for (const b of best.slice(0, 10)) {
      console.log(`${b.key.padEnd(16)} CAGR ${b.cagr.toFixed(1)}%  回撤 ${b.dd.toFixed(0)}%  MAR ${b.mar.toFixed(2)}`);
    }
  }

  if (part === "cost") {
    const picks: { label: string; slotPct: number; mode: Mode; edge: number }[] = [
      { label: "12.5% 不置换", slotPct: 0.125, mode: "none", edge: 0 },
      { label: "12.5% +20", slotPct: 0.125, mode: "weakest", edge: 20 },
      { label: "12.5% +0", slotPct: 0.125, mode: "weakest", edge: 0 },
      { label: "10% +20", slotPct: 0.1, mode: "weakest", edge: 20 },
      { label: "15% +20", slotPct: 0.15, mode: "weakest", edge: 20 },
    ];
    console.log(`\n=== ${tf} 成本敏感性（两段取差者）===`);
    console.log("配置".padEnd(16) + [0, 5, 10, 20, 30, 50].map((c) => `${c}bps`.padStart(17)).join(""));
    for (const p of picks) {
      const cells = [0, 5, 10, 20, 30, 50].map((c) => {
        const rs = [0, 1].map((i) => runRotate(uni, cfgOf(i), { ...p, costBps: c }));
        return cell(worst(rs)).padStart(17);
      });
      console.log(p.label.padEnd(16) + cells.join(""));
    }
  }

  if (part === "victim") {
    console.log(`\n=== ${tf} 受害者怎么挑：最弱 vs 随机（成本 ${costBps}bps，两段取差者）===`);
    for (const edge of [0, 15, 20, 25]) {
      const weakest = worst([0, 1].map((i) =>
        runRotate(uni, cfgOf(i), { slotPct: 0.125, mode: "weakest", edge, costBps }),
      ));
      // 随机跑多个种子，单个种子的胜负说明不了问题
      const randoms = [1, 7, 42, 99, 1234].map((seed) =>
        worst([0, 1].map((i) =>
          runRotate(uni, cfgOf(i), { slotPct: 0.125, mode: "random", edge, costBps, seed }),
        )),
      );
      const avg = {
        cagr: randoms.reduce((s, r) => s + r.cagr, 0) / randoms.length,
        dd: randoms.reduce((s, r) => s + r.dd, 0) / randoms.length,
        mar: randoms.reduce((s, r) => s + r.mar, 0) / randoms.length,
      };
      const wins = randoms.filter((r) => r.mar > weakest.mar).length;
      console.log(
        `门槛 +${String(edge).padEnd(3)} 最弱 ${cell(weakest).padEnd(20)} ` +
          `随机均值 ${cell(avg).padEnd(20)} 随机赢 ${wins}/5 次`,
      );
    }
  }

  // 三段验证：把五年切三份，取最差那段。比两段更难通过，尖峰更容易露馅
  const SEG3 = [
    { label: "第1段", from: "2021-08-24", to: "2023-04-24" },
    { label: "第2段", from: "2023-04-24", to: "2024-12-24" },
    { label: "第3段", from: "2024-12-24", to: "2026-08-24" },
  ];
  const cfg3 = (i: number, over: object) =>
    ({ ...base, ...over, from: SEG3[i].from, to: SEG3[i].to, timeframe: tf }) as BacktestConfig;
  const score3 = (over: object, o: Omit<Opts, "costBps">) => {
    const rs = [0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), { ...o, costBps }));
    const w = worst(rs);
    return { ...w, rs };
  };

  if (part === "search") {
    // 4H 走阶段2 选出的 10% 不置换；日线沿用 12.5%+20
    const pos =
      tf === "4h"
        ? { slotPct: 0.1, mode: "none" as Mode, edge: 0 }
        : { slotPct: 0.125, mode: "weakest" as Mode, edge: 20 };
    const rpsMins = [0, 20, 30, 40, 50, 60];
    const trails = [4, 5, 6, 7, 8];
    console.log(
      `\n=== ${tf} 门槛 × 吊灯（仓位 ${JSON.stringify(pos)}，成本 ${costBps}bps，三段取最差）===`,
    );
    console.log("门槛".padEnd(6) + trails.map((t) => `吊灯${t}`.padStart(18)).join(""));
    const grid: number[][] = [];
    const flat: { rpsMin: number; trailMult: number; mar: number; cagr: number; dd: number }[] = [];
    for (const [ri, rpsMin] of rpsMins.entries()) {
      grid[ri] = [];
      const cells: string[] = [];
      for (const [ti, trailMult] of trails.entries()) {
        const r = score3({ rpsMin, trailMult }, pos);
        grid[ri][ti] = r.mar;
        flat.push({ rpsMin, trailMult, mar: r.mar, cagr: r.cagr, dd: r.dd });
        cells.push(`${r.cagr.toFixed(1)}/${r.dd.toFixed(0)}/${r.mar.toFixed(2)}`.padStart(18));
      }
      console.log(String(rpsMin).padEnd(6) + cells.join(""));
    }

    // 邻域稳定性：真峰的邻居也该体面，尖刺的邻居会塌
    console.log(`\n--- ${tf} 前 8 名及邻域（邻居 MAR 均值，看是不是尖刺）---`);
    const idx = (rpsMin: number, trailMult: number) =>
      [rpsMins.indexOf(rpsMin), trails.indexOf(trailMult)] as const;
    for (const f of [...flat].sort((a, b) => b.mar - a.mar).slice(0, 8)) {
      const [ri, ti] = idx(f.rpsMin, f.trailMult);
      const nb: number[] = [];
      for (const [dr, dt] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const v = grid[ri + dr]?.[ti + dt];
        if (v != null) nb.push(v);
      }
      const avg = nb.reduce((a, b) => a + b, 0) / Math.max(1, nb.length);
      console.log(
        `门槛${String(f.rpsMin).padEnd(3)} 吊灯${String(f.trailMult).padEnd(3)} ` +
          `MAR ${f.mar.toFixed(2)}  CAGR ${f.cagr.toFixed(1)}%  回撤 ${f.dd.toFixed(0)}%  ` +
          `邻居均值 ${avg.toFixed(2)}  落差 ${(f.mar - avg).toFixed(2)}`,
      );
    }
  }

  if (part === "search2") {
    // 阶段2：策略参数固定在阶段1 的最优，专门扫仓位。4H 信号更密，未必吃得下 12.5%
    const over = tf === "4h" ? { rpsMin: 40, trailMult: 6 } : { rpsMin: 40, trailMult: 5.5 };
    const slots = [0.06, 0.08, 0.1, 0.125, 0.15, 0.2];
    const edges: (number | "none")[] = ["none", 0, 10, 15, 20, 25, 30];
    console.log(
      `\n=== ${tf} 阶段2：每笔 × 置换门槛（策略参数 ${JSON.stringify(over)}，三段取最差）===`,
    );
    console.log(
      "每笔".padEnd(7) +
        edges.map((e) => (e === "none" ? "不置换" : `+${e}`).padStart(18)).join(""),
    );
    const flat: { key: string; mar: number; cagr: number; dd: number; rs: Result[] }[] = [];
    for (const slotPct of slots) {
      const cells: string[] = [];
      for (const e of edges) {
        const r = score3(over, {
          slotPct,
          mode: e === "none" ? "none" : "weakest",
          edge: e === "none" ? 0 : e,
        });
        flat.push({
          key: `${(slotPct * 100).toFixed(1)}% ${e === "none" ? "不置换" : `+${e}`}`,
          mar: r.mar, cagr: r.cagr, dd: r.dd, rs: r.rs,
        });
        cells.push(`${r.cagr.toFixed(1)}/${r.dd.toFixed(0)}/${r.mar.toFixed(2)}`.padStart(18));
      }
      console.log(`${(slotPct * 100).toFixed(1)}%`.padEnd(7) + cells.join(""));
    }
    console.log(`\n--- ${tf} 前 5 名的三段明细 ---`);
    for (const f of [...flat].sort((a, b) => b.mar - a.mar).slice(0, 5)) {
      console.log(`\n${f.key}   取最差 CAGR ${f.cagr.toFixed(1)}%  回撤 ${f.dd.toFixed(0)}%  MAR ${f.mar.toFixed(2)}`);
      f.rs.forEach((r, i) => {
        console.log(
          `  ${SEG3[i].label} ${SEG3[i].from}→${SEG3[i].to}  CAGR ${r.cagr.toFixed(1)}%  ` +
            `回撤 ${r.dd.toFixed(0)}%  开仓 ${r.entries}  置换 ${r.rotations}  ` +
            `放弃 ${r.missed}  均持仓 ${r.avgHoldings.toFixed(1)}`,
        );
      });
    }
  }

  if (part === "confirm") {
    // 4H 三阶段搜出来的点，拿成本和不同切段方式复核一遍
    const p10 = { slotPct: 0.1, mode: "none" as Mode, edge: 0 };
    const cands =
      tf === "4h"
        ? [
            { label: "4H 门槛20/吊灯6", over: { rpsMin: 20, trailMult: 6 }, pos: p10 },
            { label: "4H 门槛30/吊灯6", over: { rpsMin: 30, trailMult: 6 }, pos: p10 },
            { label: "4H 门槛20/吊灯8", over: { rpsMin: 20, trailMult: 8 }, pos: p10 },
            { label: "4H 门槛0/吊灯4", over: { rpsMin: 0, trailMult: 4 }, pos: p10 },
            { label: "4H 冻结档 门槛50/吊灯6", over: { rpsMin: 50, trailMult: 6 }, pos: p10 },
          ]
        : [
            { label: "日线 门槛40/吊灯5.5/每笔12.5%/置换+20", over: { rpsMin: 40, trailMult: 5.5 },
              pos: { slotPct: 0.125, mode: "weakest" as Mode, edge: 20 } },
          ];

    for (const c of cands) {
      console.log(`\n=== ${c.label} ===`);
      console.log("成本    全期CAGR  全期回撤  全期MAR |  三段最差MAR  两段最差MAR");
      for (const bps of [0, 10, 20, 30, 50]) {
        const full = runRotate(
          uni,
          { ...base, ...c.over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
          { ...c.pos, costBps: bps },
        );
        const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, c.over), { ...c.pos, costBps: bps })));
        const m2 = worst(
          SEGMENTS.slice(0, 2).map(
            (s) =>
              runRotate(
                uni,
                { ...base, ...c.over, from: s.from, to: s.to, timeframe: tf } as BacktestConfig,
                { ...c.pos, costBps: bps },
              ),
          ),
        );
        console.log(
          `${String(bps).padStart(3)}bps ${full.cagr.toFixed(1).padStart(8)}% ` +
            `${full.dd.toFixed(0).padStart(8)}% ${full.mar.toFixed(2).padStart(8)} | ` +
            `${m3.mar.toFixed(2).padStart(11)} ${m2.mar.toFixed(2).padStart(12)}`,
        );
      }
      const f = runRotate(
        uni,
        { ...base, ...c.over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        { ...c.pos, costBps: 10 },
      );
      // 利润集中度：宽吊灯天生靠大赢家，得知道靠几笔。少数几笔撑起来的高收益不能推荐
      const wins = f.lotPnl.filter((x) => x.pct > 0).sort((a, b) => b.pct - a.pct);
      const gross = wins.reduce((a, b) => a + b.pct, 0);
      const share = (n: number) =>
        gross > 0
          ? (wins.slice(0, n).reduce((a, b) => a + b.pct, 0) / gross) * 100
          : 0;
      console.log(
        `  全期@10bps 开仓 ${f.entries}  放弃 ${f.missed}  均持仓 ${f.avgHoldings.toFixed(1)}  ` +
          `盈利笔数 ${wins.length}/${f.lotPnl.length}(${((wins.length / Math.max(1, f.lotPnl.length)) * 100).toFixed(0)}%)`,
      );
      console.log(
        `  毛利集中度：前1笔 ${share(1).toFixed(0)}%  前3笔 ${share(3).toFixed(0)}%  ` +
          `前5笔 ${share(5).toFixed(0)}%  前10笔 ${share(10).toFixed(0)}%`,
      );
    }
  }

  if (part === "exec") {
    console.log(`\n=== ${tf} 执行窗口对比（成本 ${costBps}bps，全期 + 三段）===`);
    console.log(
      "配置".padEnd(34) + "全期CAGR".padStart(9) + "回撤".padStart(7) +
        "MAR".padStart(7) + "三段最差".padStart(10) + "开仓".padStart(7) +
        "放弃".padStart(7) + "均持仓".padStart(8),
    );
    for (const rpsMin of [20, 30]) {
      for (const win of ["all", "dayClose"] as const) {
        for (const slotPct of [0.1, 0.125, 0.15, 0.2]) {
          const o = { slotPct, mode: "none" as Mode, edge: 0, costBps, entryWindow: win };
          const over = { rpsMin, trailMult: 6 };
          const f = runRotate(
            uni,
            { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
            o,
          );
          const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
          const label = `门槛${rpsMin} ${win === "all" ? "每根都下单" : "只收盘那根"} 每笔${(slotPct * 100).toFixed(1)}%`;
          console.log(
            label.padEnd(34) +
              `${f.cagr.toFixed(1)}%`.padStart(9) +
              `${f.dd.toFixed(0)}%`.padStart(7) +
              f.mar.toFixed(2).padStart(7) +
              m3.mar.toFixed(2).padStart(10) +
              String(f.entries).padStart(7) +
              String(f.missed).padStart(7) +
              f.avgHoldings.toFixed(1).padStart(8),
          );
        }
      }
    }
  }

  if (part === "exec2") {
    // 只收盘那根时信号密度降了一半，坑位竞争缓解，置换值得重测；仓位也要在正确门槛下重扫
    console.log(`\n=== ${tf} 只收盘那根：仓位 × 置换（成本 ${costBps}bps）===`);
    const over = { rpsMin: 20, trailMult: 6 };
    const edges: (number | "none")[] = ["none", 0, 10, 20, 30];
    console.log(
      "每笔".padEnd(7) + edges.map((e) => (e === "none" ? "不置换" : `+${e}`).padStart(20)).join(""),
    );
    for (const slotPct of [0.08, 0.1, 0.125, 0.15]) {
      const cells: string[] = [];
      for (const e of edges) {
        const o = {
          slotPct,
          mode: e === "none" ? ("none" as Mode) : ("weakest" as Mode),
          edge: e === "none" ? 0 : e,
          costBps,
          entryWindow: "dayClose" as const,
        };
        const f = runRotate(
          uni,
          { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
          o,
        );
        const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
        cells.push(
          `${f.cagr.toFixed(1)}/${f.dd.toFixed(0)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(20),
        );
      }
      console.log(`${(slotPct * 100).toFixed(1)}%`.padEnd(7) + cells.join(""));
    }
    console.log("  格式：全期CAGR/回撤/全期MAR/三段最差MAR");
  }

  if (part === "exec3") {
    console.log(`\n=== ${tf} 止损慢半天的代价（门槛20/吊灯6，成本 ${costBps}bps）===`);
    console.log(
      "入场 / 出场".padEnd(30) + "全期CAGR".padStart(9) + "回撤".padStart(7) +
        "MAR".padStart(7) + "三段最差".padStart(10) + "开仓".padStart(7) + "均持仓".padStart(8),
    );
    const over = { rpsMin: 20, trailMult: 6 };
    const combos = [
      { e: "all", x: "all", slot: 0.1, label: "每根 / 每根（回测原口径）" },
      { e: "dayClose", x: "all", slot: 0.1, label: "只收盘 / 每根（需条件单）" },
      { e: "dayClose", x: "dayClose", slot: 0.08, label: "只收盘 / 只收盘  每笔8%" },
      { e: "dayClose", x: "dayClose", slot: 0.1, label: "只收盘 / 只收盘  每笔10%" },
      { e: "dayClose", x: "dayClose", slot: 0.125, label: "只收盘 / 只收盘  每笔12.5%" },
      { e: "dayClose", x: "dayClose", slot: 0.15, label: "只收盘 / 只收盘  每笔15%" },
    ] as const;
    for (const c of combos) {
      const o = {
        slotPct: c.slot,
        mode: "none" as Mode,
        edge: 0,
        costBps,
        entryWindow: c.e,
        exitWindow: c.x,
      };
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        o,
      );
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
      console.log(
        c.label.padEnd(30) +
          `${f.cagr.toFixed(1)}%`.padStart(9) +
          `${f.dd.toFixed(0)}%`.padStart(7) +
          f.mar.toFixed(2).padStart(7) +
          m3.mar.toFixed(2).padStart(10) +
          String(f.entries).padStart(7) +
          f.avgHoldings.toFixed(1).padStart(8),
      );
    }
  }

  if (part === "exec4") {
    const over = { rpsMin: 20, trailMult: 6 };
    const mk = (slot: number, e: number | "none") => ({
      slotPct: slot,
      mode: e === "none" ? ("none" as Mode) : ("weakest" as Mode),
      edge: e === "none" ? 0 : e,
      entryWindow: "dayClose" as const,
      exitWindow: "dayClose" as const,
    });
    console.log(`\n=== 全 MOO 口径（入场出场都只在美东收盘决策）成本敏感性 ===`);
    for (const [label, o] of [
      ["每笔8% 不置换", mk(0.08, "none")],
      ["每笔8% 置换+20", mk(0.08, 20)],
      ["每笔10% 不置换", mk(0.1, "none")],
    ] as const) {
      console.log(`\n--- ${label} ---`);
      console.log("成本      CAGR    回撤     MAR   三段最差");
      for (const bps of [0, 10, 20, 30, 50]) {
        const o2 = { ...o, costBps: bps };
        const f = runRotate(
          uni,
          { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
          o2,
        );
        const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o2)));
        console.log(
          `${String(bps).padStart(3)}bps ${f.cagr.toFixed(1).padStart(7)}% ` +
            `${f.dd.toFixed(0).padStart(5)}% ${f.mar.toFixed(2).padStart(7)} ${m3.mar.toFixed(2).padStart(9)}`,
        );
      }
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        { ...o, costBps: 10 },
      );
      const wins = f.lotPnl.filter((x) => x.pct > 0);
      const gross = wins.reduce((a, b) => a + b.pct, 0);
      const top = [...wins].sort((a, b) => b.pct - a.pct);
      const share = (n: number) =>
        gross > 0 ? (top.slice(0, n).reduce((a, b) => a + b.pct, 0) / gross) * 100 : 0;
      const hc = [...f.holdCounts].sort((a, b) => a - b);
      console.log(
        `  开仓 ${f.entries} 笔/5年  胜率 ${((wins.length / Math.max(1, f.lotPnl.length)) * 100).toFixed(0)}%  ` +
          `持仓中位 ${hc[Math.floor(hc.length / 2)]}  峰值 ${hc.at(-1)}  ` +
          `前5笔占毛利 ${share(5).toFixed(0)}%`,
      );
    }
  }

  if (part === "final") {
    // 在最终执行口径下重扫策略参数。前两次顺序搜索都因为固定了错误的另一维而误判，
    // 这一遍固定的是执行方式（全 MOO + 8%），它由实操约束决定、不是拟合出来的
    const pos = {
      slotPct: 0.08,
      mode: "none" as Mode,
      edge: 0,
      costBps,
      entryWindow: "dayClose" as const,
      exitWindow: "dayClose" as const,
    };
    const cellOf = (over: object) => {
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        pos,
      );
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), pos)));
      return { f, m3 };
    };

    const trails = [4, 5, 6, 7, 8];
    console.log(`\n=== A. 门槛 × 吊灯（止损6，全MOO+8%，成本 ${costBps}bps）===`);
    console.log("       格式：全期CAGR/回撤/全期MAR/三段最差MAR");
    console.log("门槛".padEnd(6) + trails.map((t) => `吊灯${t}`.padStart(21)).join(""));
    const gridA: { mar: number; m3: number; label: string }[] = [];
    for (const rpsMin of [0, 10, 20, 30, 40, 50]) {
      const cells: string[] = [];
      for (const trailMult of trails) {
        const { f, m3 } = cellOf({ rpsMin, trailMult, stopMult: 6 });
        gridA.push({ mar: f.mar, m3: m3.mar, label: `门槛${rpsMin}/吊灯${trailMult}` });
        cells.push(
          `${f.cagr.toFixed(1)}/${f.dd.toFixed(0)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(21),
        );
      }
      console.log(String(rpsMin).padEnd(6) + cells.join(""));
    }
    console.log("\n  按全期MAR前5：" +
      [...gridA].sort((a, b) => b.mar - a.mar).slice(0, 5)
        .map((x) => `${x.label} ${x.mar.toFixed(2)}`).join("  "));
    console.log("  按三段MAR前5：" +
      [...gridA].sort((a, b) => b.m3 - a.m3).slice(0, 5)
        .map((x) => `${x.label} ${x.m3.toFixed(2)}`).join("  "));

    console.log(`\n=== B. 止损 × 吊灯（门槛20，全MOO+8%）===`);
    console.log("止损".padEnd(6) + trails.map((t) => `吊灯${t}`.padStart(21)).join(""));
    const gridB: { mar: number; m3: number; label: string }[] = [];
    for (const stopMult of [3, 4, 5, 6, 7, 8]) {
      const cells: string[] = [];
      for (const trailMult of trails) {
        const { f, m3 } = cellOf({ rpsMin: 20, trailMult, stopMult });
        gridB.push({ mar: f.mar, m3: m3.mar, label: `止损${stopMult}/吊灯${trailMult}` });
        cells.push(
          `${f.cagr.toFixed(1)}/${f.dd.toFixed(0)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(21),
        );
      }
      console.log(String(stopMult).padEnd(6) + cells.join(""));
    }
    console.log("\n  按全期MAR前5：" +
      [...gridB].sort((a, b) => b.mar - a.mar).slice(0, 5)
        .map((x) => `${x.label} ${x.mar.toFixed(2)}`).join("  "));
    console.log("  按三段MAR前5：" +
      [...gridB].sort((a, b) => b.m3 - a.m3).slice(0, 5)
        .map((x) => `${x.label} ${x.m3.toFixed(2)}`).join("  "));
  }

  if (part === "final2") {
    // 门槛 × 止损 × 吊灯 三维交叉：前面两张网格各自固定了另一维，交互项没查过
    const pos = {
      slotPct: 0.08,
      mode: "none" as Mode,
      edge: 0,
      costBps,
      entryWindow: "dayClose" as const,
      exitWindow: "dayClose" as const,
    };
    console.log(`\n=== 门槛 × 止损 × 吊灯 交叉（全MOO+8%，成本 ${costBps}bps）===`);
    console.log("       格式：全期CAGR/回撤/全期MAR/三段最差MAR");
    const rows: { label: string; mar: number; m3: number; cagr: number; dd: number }[] = [];
    for (const rpsMin of [0, 10, 20]) {
      for (const trailMult of [6, 7]) {
        const cells: string[] = [];
        for (const stopMult of [4, 5, 6]) {
          const over = { rpsMin, trailMult, stopMult };
          const f = runRotate(
            uni,
            { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
            pos,
          );
          const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), pos)));
          rows.push({
            label: `门槛${rpsMin}/止损${stopMult}/吊灯${trailMult}`,
            mar: f.mar, m3: m3.mar, cagr: f.cagr, dd: f.dd,
          });
          cells.push(
            `${f.cagr.toFixed(1)}/${f.dd.toFixed(0)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(21),
          );
        }
        console.log(`门槛${rpsMin} 吊灯${trailMult}`.padEnd(14) + cells.join(""));
      }
    }
    console.log("            " + ["止损4", "止损5", "止损6"].map((h) => h.padStart(21)).join(""));
    // 两个标准都要靠前才算稳：只在一个标准上冒头的多半是噪声
    const byMar = [...rows].sort((a, b) => b.mar - a.mar);
    const byM3 = [...rows].sort((a, b) => b.m3 - a.m3);
    console.log("\n综合排名（全期名次 + 三段名次，越小越好）：");
    for (const r of rows
      .map((r) => ({ r, s: byMar.findIndex((x) => x.label === r.label) + byM3.findIndex((x) => x.label === r.label) }))
      .sort((a, b) => a.s - b.s)
      .slice(0, 6)) {
      console.log(
        `  ${r.r.label.padEnd(24)} CAGR ${r.r.cagr.toFixed(1)}%  回撤 ${r.r.dd.toFixed(0)}%  ` +
          `全期MAR ${r.r.mar.toFixed(2)}  三段 ${r.r.m3.toFixed(2)}  名次和 ${r.s}`,
      );
    }
  }

  if (part === "final3") {
    const pos = {
      slotPct: 0.08,
      mode: "none" as Mode,
      edge: 0,
      entryWindow: "dayClose" as const,
      exitWindow: "dayClose" as const,
    };
    const cands = [
      { label: "新：门槛10/止损5/吊灯6", over: { rpsMin: 10, stopMult: 5, trailMult: 6 } },
      { label: "旧：门槛20/止损6/吊灯6", over: { rpsMin: 20, stopMult: 6, trailMult: 6 } },
    ];
    for (const c of cands) {
      console.log(`\n=== ${c.label}（全MOO + 每笔8% + 不置换）===`);
      console.log("成本      CAGR    回撤     MAR   三段最差");
      for (const bps of [0, 10, 20, 30, 50]) {
        const o = { ...pos, costBps: bps };
        const f = runRotate(
          uni,
          { ...base, ...c.over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
          o,
        );
        const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, c.over), o)));
        console.log(
          `${String(bps).padStart(3)}bps ${f.cagr.toFixed(1).padStart(7)}% ` +
            `${f.dd.toFixed(0).padStart(5)}% ${f.mar.toFixed(2).padStart(7)} ${m3.mar.toFixed(2).padStart(9)}`,
        );
      }
      const f = runRotate(
        uni,
        { ...base, ...c.over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        { ...pos, costBps: 10 },
      );
      const wins = f.lotPnl.filter((x) => x.pct > 0).sort((a, b) => b.pct - a.pct);
      const gross = wins.reduce((a, b) => a + b.pct, 0);
      const share = (n: number) =>
        gross > 0 ? (wins.slice(0, n).reduce((a, b) => a + b.pct, 0) / gross) * 100 : 0;
      const hc = [...f.holdCounts].sort((a, b) => a - b);
      console.log(
        `  开仓 ${f.entries} 笔/5年  放弃 ${f.missed}  单笔胜率 ${((wins.length / Math.max(1, f.lotPnl.length)) * 100).toFixed(0)}%  ` +
          `持仓中位 ${hc[Math.floor(hc.length / 2)]} 峰值 ${hc.at(-1)}  前5笔占毛利 ${share(5).toFixed(0)}%`,
      );
    }
  }

  if (part === "final4") {
    // 仓位也曾在门槛20 下选定，这里在新策略参数下重扫，顺带再确认置换仍是负贡献
    const over = { rpsMin: 10, stopMult: 5, trailMult: 6 };
    const edges: (number | "none")[] = ["none", 10, 20, 30];
    console.log(`\n=== 门槛10/止损5/吊灯6 下的仓位 × 置换（全MOO，成本 ${costBps}bps）===`);
    console.log("       格式：全期CAGR/回撤/全期MAR/三段最差MAR");
    console.log(
      "每笔".padEnd(7) + edges.map((e) => (e === "none" ? "不置换" : `+${e}`).padStart(21)).join(""),
    );
    for (const slotPct of [0.06, 0.08, 0.1, 0.125, 0.15]) {
      const cells: string[] = [];
      for (const e of edges) {
        const o = {
          slotPct,
          mode: e === "none" ? ("none" as Mode) : ("weakest" as Mode),
          edge: e === "none" ? 0 : e,
          costBps,
          entryWindow: "dayClose" as const,
          exitWindow: "dayClose" as const,
        };
        const f = runRotate(
          uni,
          { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
          o,
        );
        const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
        cells.push(
          `${f.cagr.toFixed(1)}/${f.dd.toFixed(0)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(21),
        );
      }
      console.log(`${(slotPct * 100).toFixed(1)}%`.padEnd(7) + cells.join(""));
    }
  }

  if (part === "final5") {
    // 执行窗口之前被我当成外生约束固定成 dayClose，策略参数全在它下面选的。
    // 这里在新参数下把四种执行方式 × 仓位一起铺开，代价到底多大要有数
    const over = { rpsMin: 10, stopMult: 5, trailMult: 6 };
    const wins = [
      { e: "all", x: "all", label: "信号即下单/即止损" },
      { e: "all", x: "dayClose", label: "信号即下单/收盘止损" },
      { e: "dayClose", x: "all", label: "收盘下单/即止损" },
      { e: "dayClose", x: "dayClose", label: "全收盘(现推荐)" },
    ] as const;
    console.log(`\n=== 执行窗口 × 仓位（门槛10/止损5/吊灯6，成本 ${costBps}bps）===`);
    console.log("       格式：全期CAGR/回撤/全期MAR/三段最差MAR");
    const slots = [0.06, 0.08, 0.1, 0.125];
    console.log("执行方式".padEnd(24) + slots.map((s) => `每笔${(s * 100).toFixed(1)}%`.padStart(21)).join(""));
    const rows: { label: string; mar: number; m3: number; cagr: number; dd: number; entries: number; missed: number }[] = [];
    for (const w of wins) {
      const cells: string[] = [];
      for (const slotPct of slots) {
        const o = {
          slotPct,
          mode: "none" as Mode,
          edge: 0,
          costBps,
          entryWindow: w.e,
          exitWindow: w.x,
        };
        const f = runRotate(
          uni,
          { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
          o,
        );
        const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
        rows.push({
          label: `${w.label} ${(slotPct * 100).toFixed(1)}%`,
          mar: f.mar, m3: m3.mar, cagr: f.cagr, dd: f.dd, entries: f.entries, missed: f.missed,
        });
        cells.push(
          `${f.cagr.toFixed(1)}/${f.dd.toFixed(0)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(21),
        );
      }
      console.log(w.label.padEnd(24) + cells.join(""));
    }
    const byMar = [...rows].sort((a, b) => b.mar - a.mar);
    const byM3 = [...rows].sort((a, b) => b.m3 - a.m3);
    console.log("\n综合排名（全期名次 + 三段名次）：");
    for (const r of rows
      .map((r) => ({ r, s: byMar.findIndex((x) => x.label === r.label) + byM3.findIndex((x) => x.label === r.label) }))
      .sort((a, b) => a.s - b.s)
      .slice(0, 6)) {
      console.log(
        `  ${r.r.label.padEnd(30)} CAGR ${r.r.cagr.toFixed(1)}%  回撤 ${r.r.dd.toFixed(0)}%  ` +
          `全期MAR ${r.r.mar.toFixed(2)}  三段 ${r.r.m3.toFixed(2)}  开仓 ${r.r.entries} 放弃 ${r.r.missed}`,
      );
    }
  }

  if (part === "final6") {
    // 收敛确认：执行口径定为「收盘入场 / 即时出场」后，策略参数是否还站得住
    console.log(`\n=== 收盘入场 + 即时出场：门槛 × 吊灯 × 仓位（止损5，成本 ${costBps}bps）===`);
    console.log("       格式：全期CAGR/回撤/全期MAR/三段最差MAR");
    const rows: { label: string; mar: number; m3: number; cagr: number; dd: number }[] = [];
    for (const slotPct of [0.08, 0.1]) {
      const o = {
        slotPct,
        mode: "none" as Mode,
        edge: 0,
        costBps,
        entryWindow: "dayClose" as const,
        exitWindow: "all" as const,
      };
      console.log(`\n--- 每笔 ${(slotPct * 100).toFixed(0)}% ---`);
      const trails = [5, 6, 7];
      console.log("门槛".padEnd(6) + trails.map((t) => `吊灯${t}`.padStart(21)).join(""));
      for (const rpsMin of [0, 10, 20, 30]) {
        const cells: string[] = [];
        for (const trailMult of trails) {
          const over = { rpsMin, stopMult: 5, trailMult };
          const f = runRotate(
            uni,
            { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
            o,
          );
          const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
          rows.push({
            label: `门槛${rpsMin}/吊灯${trailMult}/${(slotPct * 100).toFixed(0)}%`,
            mar: f.mar, m3: m3.mar, cagr: f.cagr, dd: f.dd,
          });
          cells.push(
            `${f.cagr.toFixed(1)}/${f.dd.toFixed(0)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(21),
          );
        }
        console.log(String(rpsMin).padEnd(6) + cells.join(""));
      }
    }
    const byMar = [...rows].sort((a, b) => b.mar - a.mar);
    const byM3 = [...rows].sort((a, b) => b.m3 - a.m3);
    console.log("\n综合排名（全期名次 + 三段名次）：");
    for (const r of rows
      .map((r) => ({ r, s: byMar.findIndex((x) => x.label === r.label) + byM3.findIndex((x) => x.label === r.label) }))
      .sort((a, b) => a.s - b.s)
      .slice(0, 6)) {
      console.log(
        `  ${r.r.label.padEnd(22)} CAGR ${r.r.cagr.toFixed(1)}%  回撤 ${r.r.dd.toFixed(0)}%  ` +
          `全期MAR ${r.r.mar.toFixed(2)}  三段 ${r.r.m3.toFixed(2)}`,
      );
    }
  }

  if (part === "oos") {
    // 真正的样本外：2021-08→2024-08 选参，2024-08→2026-08 只跑一次。
    // 之前的「三段最差 MAR」三段都参与了选参，只是稳健性代理，不是 holdout
    const TRAIN = { from: "2021-08-24", to: "2024-08-24" };
    const TEST = { from: "2024-08-24", to: "2026-08-24" };
    const mkPos = (slotPct: number) => ({
      slotPct,
      mode: "none" as Mode,
      edge: 0,
      costBps,
      entryWindow: "dayClose" as const,
      exitWindow: "all" as const,
    });
    const run = (win: { from: string; to: string }, over: object, slotPct: number) =>
      runRotate(
        uni,
        { ...base, ...over, ...win, timeframe: tf } as BacktestConfig,
        mkPos(slotPct),
      );

    const cands: { label: string; over: object; slot: number; train: Result }[] = [];
    for (const rpsMin of [0, 10, 20, 30]) {
      for (const trailMult of [5, 6, 7]) {
        for (const slot of [0.08, 0.1, 0.125]) {
          const over = { rpsMin, stopMult: 5, trailMult };
          cands.push({
            label: `门槛${rpsMin}/吊灯${trailMult}/${(slot * 100).toFixed(1)}%`,
            over, slot, train: run(TRAIN, over, slot),
          });
        }
      }
    }
    cands.sort((a, b) => b.train.mar - a.train.mar);
    console.log(`\n=== 训练期 ${TRAIN.from} → ${TRAIN.to} 上的前 5 名 ===`);
    for (const c of cands.slice(0, 5)) {
      console.log(
        `  ${c.label.padEnd(24)} CAGR ${c.train.cagr.toFixed(1)}%  回撤 ${c.train.dd.toFixed(0)}%  MAR ${c.train.mar.toFixed(2)}`,
      );
    }

    const pick = cands[0];
    console.log(`\n=== 样本外 ${TEST.from} → ${TEST.to}（只跑一次）===`);
    console.log("  用训练期冠军参数：" + pick.label);
    const oos = run(TEST, pick.over, pick.slot);
    console.log(
      `  样本外：CAGR ${oos.cagr.toFixed(1)}%  回撤 ${oos.dd.toFixed(0)}%  MAR ${oos.mar.toFixed(2)}  开仓 ${oos.entries} 笔`,
    );

    // 现用冻结档在同一段样本外的表现，用来看「换参数」和「换时段」各贡献多少
    const frozen = { rpsMin: 10, stopMult: 5, trailMult: 6 };
    const oosFrozen = run(TEST, frozen, 0.1);
    console.log(
      `  现冻结档(门槛10/吊灯6/10%)在同段：CAGR ${oosFrozen.cagr.toFixed(1)}%  ` +
        `回撤 ${oosFrozen.dd.toFixed(0)}%  MAR ${oosFrozen.mar.toFixed(2)}`,
    );

    // 训练期前 5 名在样本外的排名漂移：若参数带有真实信息，训练期靠前的不该在样本外垫底
    console.log(`\n=== 训练期前 8 名在样本外的表现（看排名是否守得住）===`);
    const withOos = cands.slice(0, 8).map((c) => ({ c, o: run(TEST, c.over, c.slot) }));
    const oosRank = [...cands].map((c) => ({ label: c.label, mar: run(TEST, c.over, c.slot).mar }))
      .sort((a, b) => b.mar - a.mar);
    for (const [i, x] of withOos.entries()) {
      const r = oosRank.findIndex((y) => y.label === x.c.label) + 1;
      console.log(
        `  训练第${i + 1} ${x.c.label.padEnd(24)} 训练MAR ${x.c.train.mar.toFixed(2)}  ` +
          `样本外MAR ${x.o.mar.toFixed(2)}  样本外排名 ${r}/${cands.length}`,
      );
    }
    const spearman = (() => {
      const trainRank = new Map(cands.map((c, i) => [c.label, i + 1]));
      const pairs = oosRank.map((o, i) => [trainRank.get(o.label)!, i + 1]);
      const n = pairs.length;
      const dsq = pairs.reduce((a, [x, y]) => a + (x - y) ** 2, 0);
      return 1 - (6 * dsq) / (n * (n * n - 1));
    })();
    console.log(`\n  训练期与样本外的排名相关性（Spearman）：${spearman.toFixed(2)}`);
    console.log("  接近 0 = 训练期的名次对样本外没有预测力，即选参选到的是噪声");
  }

  if (part === "final7") {
    // 8% vs 10%：训练期 / 样本外 / 全期三个窗口并列
    const WINS = [
      { label: "训练 2021-08→2024-08", from: "2021-08-24", to: "2024-08-24" },
      { label: "样本外 2024-08→2026-08", from: "2024-08-25", to: "2026-08-24" },
      { label: "全期 2021-08→2026-08", from: SEGMENTS[2].from, to: SEGMENTS[2].to },
    ];
    const over = { rpsMin: 10, stopMult: 5, trailMult: 6 };
    for (const slotPct of [0.08, 0.1]) {
      console.log(`\n=== 门槛10/止损5/吊灯6 · 每笔 ${(slotPct * 100).toFixed(0)}% ===`);
      console.log("窗口".padEnd(26) + "CAGR".padStart(8) + "回撤".padStart(8) + "MAR".padStart(8) + "开仓".padStart(7));
      for (const w of WINS) {
        const f = runRotate(
          uni,
          { ...base, ...over, from: w.from, to: w.to, timeframe: tf } as BacktestConfig,
          {
            slotPct, mode: "none" as Mode, edge: 0, costBps,
            entryWindow: "dayClose" as const, exitWindow: "all" as const,
          },
        );
        console.log(
          w.label.padEnd(26) + `${f.cagr.toFixed(1)}%`.padStart(8) +
            `${f.dd.toFixed(0)}%`.padStart(8) + f.mar.toFixed(2).padStart(8) +
            String(f.entries).padStart(7),
        );
      }
    }
  }

  if (part === "hold2") {
    const f = runRotate(
      uni,
      {
        ...base, rpsMin: 10, stopMult: 5, trailMult: 6,
        from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf,
      } as BacktestConfig,
      {
        slotPct: 0.1, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: "dayClose" as const, exitWindow: "all" as const,
      },
    );
    const hc = f.holdCounts;
    const n = hc.length;
    const sorted = [...hc].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.floor((sorted.length - 1) * p)];
    console.log(`\n=== 当前 4H 冻结档的持仓分布（${n} 根 4H K，成本 ${costBps}bps）===`);
    console.log(
      `  中位数 ${q(0.5)}  均值 ${(hc.reduce((a, b) => a + b, 0) / n).toFixed(1)}  ` +
        `峰值 ${sorted.at(-1)}  最小 ${sorted[0]}`,
    );
    console.log(`  分位：10% 处 ${q(0.1)}   25% 处 ${q(0.25)}   75% 处 ${q(0.75)}   90% 处 ${q(0.9)}`);
    console.log(`  平均股票敞口 ${f.avgExposure.toFixed(0)}%（其余是现金）`);
    console.log("\n  持仓只数   占时间比    累计");
    const maxH = sorted.at(-1)!;
    let cum = 0;
    for (let k = 0; k <= maxH; k += 1) {
      const c = hc.filter((x) => x === k).length;
      if (c === 0) continue;
      cum += c;
      const bar = "#".repeat(Math.round((c / n) * 60));
      console.log(
        `  ${String(k).padStart(6)}   ${((c / n) * 100).toFixed(1).padStart(6)}%  ` +
          `${((cum / n) * 100).toFixed(0).padStart(5)}%  ${bar}`,
      );
    }
    console.log(
      `\n  开仓 ${f.entries} 笔  因现金不足放弃 ${f.missed} 次  ` +
        `放弃率 ${((f.missed / (f.missed + f.entries)) * 100).toFixed(0)}%`,
    );
  }

  if (part === "dilute") {
    // 「放弃率太高」的直接解法是把单笔调小、坑位调多。把比例轴一直压到 2% 看趋势
    const over = { rpsMin: 10, stopMult: 5, trailMult: 6 };
    console.log(`\n=== 单笔比例 → 放弃率与表现（门槛10/止损5/吊灯6，成本 ${costBps}bps）===`);
    console.log(
      "每笔".padEnd(7) + "理论坑位".padStart(9) + "CAGR".padStart(8) + "回撤".padStart(7) +
        "MAR".padStart(7) + "三段最差".padStart(10) + "开仓".padStart(7) +
        "放弃率".padStart(8) + "持仓中位".padStart(9) + "敞口".padStart(7),
    );
    for (const slotPct of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.125, 0.15]) {
      const o = {
        slotPct, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: "dayClose" as const, exitWindow: "all" as const,
      };
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        o,
      );
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
      const hc = [...f.holdCounts].sort((a, b) => a - b);
      console.log(
        `${(slotPct * 100).toFixed(0)}%`.padEnd(7) +
          String(Math.floor(1 / slotPct)).padStart(9) +
          `${f.cagr.toFixed(1)}%`.padStart(8) + `${f.dd.toFixed(0)}%`.padStart(7) +
          f.mar.toFixed(2).padStart(7) + m3.mar.toFixed(2).padStart(10) +
          String(f.entries).padStart(7) +
          `${((f.missed / (f.missed + f.entries)) * 100).toFixed(0)}%`.padStart(8) +
          String(hc[Math.floor(hc.length / 2)]).padStart(9) +
          `${f.avgExposure.toFixed(0)}%`.padStart(7),
      );
    }
  }

  if (part === "nest") {
    // 多周期嵌套：用日线状态给 4H 入场加一道确认。日线面板单独加载，
    // 决策发生在美东收盘那根，此时当天日线已收盘，用当天状态不构成前视
    const daily = await getPreparedUniverse("SMALLFUND", "1d");
    const dailyIdx = new Map(daily.axis.map((a, i) => [a.slice(0, 10), i]));
    type DayState = { vegas: boolean; trend: boolean; buyBarsAgo: number };
    const states = new Map<string, Map<string, DayState>>();
    for (const sym of daily.symbols) {
      const m = new Map<string, DayState>();
      let lastBuy = -1e9;
      for (let i = 0; i < sym.axisIndex.length; i += 1) {
        if (sym.buy1[i] === 1 || sym.buy2[i] === 1) lastBuy = i;
        m.set(daily.axis[sym.axisIndex[i]].slice(0, 10), {
          vegas: sym.vegasOk[i] === 1,
          trend: sym.aboveTrend[i] === 1,
          buyBarsAgo: i - lastBuy,
        });
      }
      states.set(sym.ticker, m);
    }
    const lookup = (ticker: string, date: string) =>
      states.get(ticker)?.get(date.slice(0, 10)) ?? null;

    const over = { rpsMin: 10, stopMult: 5, trailMult: 6 };
    const gates: { label: string; gate?: (t: string, d: string) => boolean }[] = [
      { label: "基线（无日线确认）" },
      {
        label: "＋日线 Vegas 多头",
        gate: (t, d) => lookup(t, d)?.vegas ?? false,
      },
      {
        label: "＋日线站上 MA200/850",
        gate: (t, d) => lookup(t, d)?.trend ?? false,
      },
      {
        label: "＋日线 Vegas 且 MA",
        gate: (t, d) => {
          const s = lookup(t, d);
          return !!s && s.vegas && s.trend;
        },
      },
      {
        label: "＋日线 5 天内有买点",
        gate: (t, d) => (lookup(t, d)?.buyBarsAgo ?? 1e9) <= 5,
      },
      {
        label: "＋日线 20 天内有买点",
        gate: (t, d) => (lookup(t, d)?.buyBarsAgo ?? 1e9) <= 20,
      },
      {
        label: "＋日线 60 天内有买点",
        gate: (t, d) => (lookup(t, d)?.buyBarsAgo ?? 1e9) <= 60,
      },
    ];

    console.log(`\n=== 4H 入场 ＋ 日线确认（门槛10/止损5/吊灯6，每笔10%，成本 ${costBps}bps）===`);
    console.log(
      "规则".padEnd(26) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
        "三段最差".padStart(10) + "开仓".padStart(7) + "持仓中位".padStart(9) + "敞口".padStart(7),
    );
    for (const g of gates) {
      const o = {
        slotPct: 0.1, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: "dayClose" as const, exitWindow: "all" as const,
        entryGate: g.gate,
      };
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        o,
      );
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
      const hc = [...f.holdCounts].sort((a, b) => a - b);
      console.log(
        g.label.padEnd(26) + `${f.cagr.toFixed(1)}%`.padStart(8) +
          `${f.dd.toFixed(0)}%`.padStart(7) + f.mar.toFixed(2).padStart(7) +
          m3.mar.toFixed(2).padStart(10) + String(f.entries).padStart(7) +
          String(hc[Math.floor(hc.length / 2)]).padStart(9) +
          `${f.avgExposure.toFixed(0)}%`.padStart(7),
      );
    }
  }

  if (part === "regime") {
    const daily = await getPreparedUniverse("SMALLFUND", "1d");
    // 广度：当日池内「日线 Vegas 多头」的成分股占比
    const breadth = new Map<string, number>();
    for (let i = 0; i < daily.axis.length; i += 1) breadth.set(daily.axis[i].slice(0, 10), 0);
    const memberCnt = new Map<string, number>();
    const bullCnt = new Map<string, number>();
    for (const sym of daily.symbols) {
      for (let k = 0; k < sym.axisIndex.length; k += 1) {
        if (sym.isMember[k] !== 1) continue;
        const d0 = daily.axis[sym.axisIndex[k]].slice(0, 10);
        memberCnt.set(d0, (memberCnt.get(d0) ?? 0) + 1);
        if (sym.vegasOk[k] === 1) bullCnt.set(d0, (bullCnt.get(d0) ?? 0) + 1);
      }
    }
    for (const [d0, m] of memberCnt) breadth.set(d0, m > 0 ? (bullCnt.get(d0) ?? 0) / m : 0);
    const bvals = [...breadth.entries()].filter(([d0]) => d0 >= SEGMENTS[2].from && d0 <= SEGMENTS[2].to);
    const sortedB = bvals.map(([, v]) => v).sort((a, b) => a - b);
    const qb = (p: number) => sortedB[Math.floor((sortedB.length - 1) * p)];
    console.log(`\n=== 池内日线 Vegas 多头广度分布（${sortedB.length} 天）===`);
    console.log(
      `  最低 ${(sortedB[0] * 100).toFixed(0)}%  10分位 ${(qb(0.1) * 100).toFixed(0)}%  ` +
        `25分位 ${(qb(0.25) * 100).toFixed(0)}%  中位 ${(qb(0.5) * 100).toFixed(0)}%  ` +
        `75分位 ${(qb(0.75) * 100).toFixed(0)}%  最高 ${(sortedB.at(-1)! * 100).toFixed(0)}%`,
    );
    for (const y of ["2021", "2022", "2023", "2024", "2025", "2026"]) {
      const ys = bvals.filter(([d0]) => d0.startsWith(y)).map(([, v]) => v);
      if (ys.length) {
        console.log(
          `  ${y} 均值 ${((ys.reduce((a, b) => a + b, 0) / ys.length) * 100).toFixed(0)}%  ` +
            `最低 ${(Math.min(...ys) * 100).toFixed(0)}%`,
        );
      }
    }

    const bOf = (date: string) => breadth.get(date.slice(0, 10)) ?? 1;
    const dailyIdx2 = new Map<string, Map<string, boolean>>();
    for (const sym of daily.symbols) {
      const m = new Map<string, boolean>();
      for (let k = 0; k < sym.axisIndex.length; k += 1) {
        m.set(
          daily.axis[sym.axisIndex[k]].slice(0, 10),
          sym.vegasOk[k] === 1 && sym.aboveTrend[k] === 1,
        );
      }
      dailyIdx2.set(sym.ticker, m);
    }
    const strongOf = (t: string, d0: string) => dailyIdx2.get(t)?.get(d0.slice(0, 10)) ?? false;

    const over = { rpsMin: 10, stopMult: 5, trailMult: 6 };
    const variants: { label: string; o: Partial<Opts> }[] = [
      { label: "基线 固定10%", o: {} },
      {
        label: "单票 日线强12%/弱6%",
        o: { slotScale: (t, d0) => (strongOf(t, d0) ? 1.2 : 0.6) },
      },
      {
        label: "单票 日线强10%/弱5%",
        o: { slotScale: (t, d0) => (strongOf(t, d0) ? 1.0 : 0.5) },
      },
      {
        label: "广度 >50%→10% 否则5%",
        o: { slotPctOf: (d0) => (bOf(d0) > 0.5 ? 0.1 : 0.05) },
      },
      {
        label: "广度 三档 12.5/8/4%",
        o: {
          slotPctOf: (d0) => {
            const b = bOf(d0);
            return b > 0.6 ? 0.125 : b > 0.4 ? 0.08 : 0.04;
          },
        },
      },
      {
        label: "广度 <40%→停手",
        o: { slotPctOf: (d0) => (bOf(d0) < 0.4 ? 0 : 0.1) },
      },
      {
        label: "广度 <30%→停手",
        o: { slotPctOf: (d0) => (bOf(d0) < 0.3 ? 0 : 0.1) },
      },
      {
        label: "广度 线性 4%~14%",
        o: { slotPctOf: (d0) => 0.04 + 0.1 * Math.min(1, Math.max(0, bOf(d0))) },
      },
    ];

    console.log(`\n=== 日线状态调节仓位（门槛10/止损5/吊灯6，成本 ${costBps}bps）===`);
    console.log(
      "规则".padEnd(26) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
        "三段最差".padStart(10) + "开仓".padStart(7) + "持仓中位".padStart(9) + "敞口".padStart(7),
    );
    for (const v of variants) {
      const o = {
        slotPct: 0.1, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: "dayClose" as const, exitWindow: "all" as const,
        ...v.o,
      };
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        o,
      );
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
      const hc = [...f.holdCounts].sort((a, b) => a - b);
      console.log(
        v.label.padEnd(26) + `${f.cagr.toFixed(1)}%`.padStart(8) +
          `${f.dd.toFixed(0)}%`.padStart(7) + f.mar.toFixed(2).padStart(7) +
          m3.mar.toFixed(2).padStart(10) + String(f.entries).padStart(7) +
          String(hc[Math.floor(hc.length / 2)]).padStart(9) +
          `${f.avgExposure.toFixed(0)}%`.padStart(7),
      );
    }
  }

  if (part === "placebo") {
    // 线性广度档的优势到底来自「状态信息」还是「仓位变大/会浮动」？
    // 用同分布但时间错位的广度、以及纯随机仓位做对照
    const daily = await getPreparedUniverse("SMALLFUND", "1d");
    const memberCnt = new Map<string, number>();
    const bullCnt = new Map<string, number>();
    for (const sym of daily.symbols) {
      for (let k = 0; k < sym.axisIndex.length; k += 1) {
        if (sym.isMember[k] !== 1) continue;
        const d0 = daily.axis[sym.axisIndex[k]].slice(0, 10);
        memberCnt.set(d0, (memberCnt.get(d0) ?? 0) + 1);
        if (sym.vegasOk[k] === 1) bullCnt.set(d0, (bullCnt.get(d0) ?? 0) + 1);
      }
    }
    const dates = [...memberCnt.keys()].sort();
    const breadth = new Map<string, number>();
    for (const d0 of dates) breadth.set(d0, (bullCnt.get(d0) ?? 0) / memberCnt.get(d0)!);

    const slotOfB = (b: number) => 0.04 + 0.1 * Math.min(1, Math.max(0, b));
    const real = (d0: string) => slotOfB(breadth.get(d0.slice(0, 10)) ?? 0.78);

    // 同一组广度值打乱到别的日期上：分布一致，只毁掉时间对应关系
    let sd = 987654321;
    const rnd = () => ((sd = (sd * 1103515245 + 12345) % 2147483648), sd / 2147483648);
    const vals = dates.map((d0) => breadth.get(d0)!);
    for (let i = vals.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [vals[i], vals[j]] = [vals[j], vals[i]];
    }
    const shuffled = new Map(dates.map((d0, i) => [d0, vals[i]]));
    const shuf = (d0: string) => slotOfB(shuffled.get(d0.slice(0, 10)) ?? 0.78);

    const avgSlot = dates.reduce((a, d0) => a + slotOfB(breadth.get(d0)!), 0) / dates.length;

    const over = { rpsMin: 10, stopMult: 5, trailMult: 6 };
    const runs: { label: string; o: Partial<Opts> }[] = [
      { label: "基线 固定10%", o: { slotPct: 0.1 } },
      { label: `对照 固定${(avgSlot * 100).toFixed(1)}%（同均值）`, o: { slotPct: avgSlot } },
      { label: "真广度 线性4%~14%", o: { slotPctOf: real } },
      { label: "安慰剂A 广度打乱时序", o: { slotPctOf: shuf } },
    ];
    // 安慰剂B：在真广度的取值区间内纯随机，跑多个种子看分布
    const lo2 = Math.min(...dates.map((d0) => slotOfB(breadth.get(d0)!)));
    const hi2 = Math.max(...dates.map((d0) => slotOfB(breadth.get(d0)!)));
    console.log(`\n=== 安慰剂对照（门槛10/止损5/吊灯6，成本 ${costBps}bps）===`);
    console.log(`  线性档实际仓位区间 ${(lo2 * 100).toFixed(1)}% ~ ${(hi2 * 100).toFixed(1)}%，均值 ${(avgSlot * 100).toFixed(1)}%`);
    console.log(
      "\n规则".padEnd(30) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
        "三段最差".padStart(10) + "开仓".padStart(7),
    );
    const show = (label: string, o: Partial<Opts>) => {
      const opt = {
        slotPct: 0.1, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: "dayClose" as const, exitWindow: "all" as const, ...o,
      };
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        opt,
      );
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), opt)));
      console.log(
        label.padEnd(30) + `${f.cagr.toFixed(1)}%`.padStart(8) + `${f.dd.toFixed(0)}%`.padStart(7) +
          f.mar.toFixed(2).padStart(7) + m3.mar.toFixed(2).padStart(10) + String(f.entries).padStart(7),
      );
      return f.mar;
    };
    for (const r of runs) show(r.label, r.o);

    const mars: number[] = [];
    for (let k = 0; k < 6; k += 1) {
      let s2 = 24680 + k * 7919;
      const rr = () => ((s2 = (s2 * 1103515245 + 12345) % 2147483648), s2 / 2147483648);
      const cache = new Map<string, number>();
      const fn = (d0: string) => {
        const key = d0.slice(0, 10);
        if (!cache.has(key)) cache.set(key, lo2 + rr() * (hi2 - lo2));
        return cache.get(key)!;
      };
      mars.push(show(`安慰剂B 纯随机仓位 种子${k + 1}`, { slotPctOf: fn }));
    }
    mars.sort((a, b) => a - b);
    console.log(
      `\n  纯随机仓位的 MAR 分布：${mars.map((m) => m.toFixed(2)).join(" / ")}` +
        `  中位 ${mars[Math.floor(mars.length / 2)].toFixed(2)}`,
    );
  }

  if (part === "reverse") {
    // 慢进快出：日线出信号才开仓，但用 4H 的 ATR 尺度做风控
    const daily = await getPreparedUniverse("SMALLFUND", "1d");
    const dcfg = {
      ...DEFAULT_BACKTEST_CONFIG, ...SMALL_FUND_DEFAULT_CONFIG,
      from: SEGMENTS[2].from, to: SEGMENTS[2].to, splitDate: "2099-01-01", timeframe: "1d",
    } as BacktestConfig;
    const db = windowBounds(daily.axis, dcfg);
    const dailyEntry = new Map<string, Set<string>>();
    let sigTotal = 0;
    for (const dsym of daily.symbols) {
      const dinp = prepareSymbolInputs(daily.axis, dsym, dcfg, db.lo, db.hi);
      const days = new Set<string>();
      for (let k = 0; k < dinp.buy1.length; k += 1) {
        if (dinp.buy1[k] || dinp.buy2[k]) days.add(daily.axis[dsym.axisIndex[k]].slice(0, 10));
      }
      sigTotal += days.size;
      dailyEntry.set(dsym.ticker, days);
    }
    console.log(`\n日线冻结档在全期共 ${sigTotal} 个买点日（分布到 ${daily.symbols.length} 只票）`);

    const cell = (over: object, slotPct: number, de?: Map<string, Set<string>>) => {
      const o = {
        slotPct, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: "dayClose" as const, exitWindow: "all" as const, dailyEntry: de,
      };
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        o,
      );
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
      return { f, m3 };
    };

    console.log(`\n=== 反向嵌套：日线入场 + 4H 风控（每笔10%，成本 ${costBps}bps）===`);
    console.log("       格式：全期CAGR/回撤/全期MAR/三段最差");
    const trails = [4, 6, 8, 10, 12];
    console.log("止损".padEnd(6) + trails.map((t) => `吊灯${t}`.padStart(21)).join(""));
    const rows: { label: string; mar: number; m3: number; cagr: number; dd: number; entries: number }[] = [];
    for (const stopMult of [4, 6, 8]) {
      const cells: string[] = [];
      for (const trailMult of trails) {
        const over = { rpsMin: 10, stopMult, trailMult };
        const { f, m3 } = cell(over, 0.1, dailyEntry);
        rows.push({
          label: `止损${stopMult}/吊灯${trailMult}`, mar: f.mar, m3: m3.mar,
          cagr: f.cagr, dd: f.dd, entries: f.entries,
        });
        cells.push(
          `${f.cagr.toFixed(1)}/${f.dd.toFixed(0)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(21),
        );
      }
      console.log(String(stopMult).padEnd(6) + cells.join(""));
    }
    const top = [...rows].sort((a, b) => b.mar - a.mar)[0];
    console.log(
      `\n  最优：${top.label}  CAGR ${top.cagr.toFixed(1)}%  回撤 ${top.dd.toFixed(0)}%  ` +
        `MAR ${top.mar.toFixed(2)}  三段 ${top.m3.toFixed(2)}  开仓 ${top.entries} 笔`,
    );

    console.log(`\n=== 三条腿并列对照 ===`);
    console.log(
      "口径".padEnd(30) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
        "三段最差".padStart(10) + "开仓".padStart(7),
    );
    const show = (label: string, over: object, slot: number, de?: Map<string, Set<string>>) => {
      const { f, m3 } = cell(over, slot, de);
      console.log(
        label.padEnd(30) + `${f.cagr.toFixed(1)}%`.padStart(8) + `${f.dd.toFixed(0)}%`.padStart(7) +
          f.mar.toFixed(2).padStart(7) + m3.mar.toFixed(2).padStart(10) + String(f.entries).padStart(7),
      );
    };
    show("4H 入场 + 4H 风控（现档）", { rpsMin: 10, stopMult: 5, trailMult: 6 }, 0.1);
    const bestOver = {
      rpsMin: 10,
      stopMult: Number(top.label.match(/止损(\d+)/)![1]),
      trailMult: Number(top.label.match(/吊灯(\d+)/)![1]),
    };
    show("日线入场 + 4H 风控（最优）", bestOver, 0.1, dailyEntry);
    for (const slot of [0.125, 0.15, 0.2]) {
      show(`日线入场 + 4H 风控 每笔${(slot * 100).toFixed(0)}%`, bestOver, slot, dailyEntry);
    }
  }

  if (part === "diag") {
    // 牛市跑输,是「上不了车」还是「上了车拿不住」？分时段拆持仓画像
    const WINS = [
      { label: "训练 2021-08→2024-08（含熊市）", from: "2021-08-24", to: "2024-08-24" },
      { label: "样本外 2024-08→2026-08（牛市）", from: "2024-08-25", to: "2026-08-24" },
    ];
    const over = { rpsMin: 10, stopMult: 5, trailMult: 6 };
    console.log(`\n=== 分时段持仓画像（门槛10/止损5/吊灯6，每笔10%，成本 ${costBps}bps）===`);
    for (const w of WINS) {
      const f = runRotate(
        uni,
        { ...base, ...over, from: w.from, to: w.to, timeframe: tf } as BacktestConfig,
        {
          slotPct: 0.1, mode: "none" as Mode, edge: 0, costBps,
          entryWindow: "dayClose" as const, exitWindow: "all" as const,
        },
      );
      const hc = f.holdCounts;
      const n = hc.length;
      const sorted = [...hc].sort((a, b) => a - b);
      const bars = barsPerYearOf(tf);
      const yrs = n / bars;
      const wins = f.lotPnl.filter((x) => x.pct > 0);
      console.log(`\n--- ${w.label} ---`);
      console.log(
        `  CAGR ${f.cagr.toFixed(1)}%  回撤 ${f.dd.toFixed(0)}%  MAR ${f.mar.toFixed(2)}`,
      );
      console.log(
        `  敞口 ${f.avgExposure.toFixed(0)}%   持仓中位 ${sorted[Math.floor(n / 2)]}   ` +
          `均值 ${(hc.reduce((a, b) => a + b, 0) / n).toFixed(1)}   峰值 ${sorted.at(-1)}`,
      );
      console.log(
        `  空仓占时间 ${((hc.filter((x) => x === 0).length / n) * 100).toFixed(1)}%   ` +
          `持仓≥8只占 ${((hc.filter((x) => x >= 8).length / n) * 100).toFixed(1)}%   ` +
          `持仓≤4只占 ${((hc.filter((x) => x <= 4).length / n) * 100).toFixed(1)}%`,
      );
      console.log(
        `  开仓 ${f.entries} 笔（年均 ${(f.entries / yrs).toFixed(0)}）   ` +
          `放弃 ${f.missed}（年均 ${(f.missed / yrs).toFixed(0)}）   ` +
          `放弃率 ${((f.missed / (f.missed + f.entries)) * 100).toFixed(0)}%`,
      );
      console.log(
        `  单笔胜率 ${((wins.length / Math.max(1, f.lotPnl.length)) * 100).toFixed(0)}%   ` +
          `平均盈利笔 +${(wins.reduce((a, b) => a + b.pct, 0) / Math.max(1, wins.length)).toFixed(2)}%权益   ` +
          `平均亏损笔 ${(() => {
            const l = f.lotPnl.filter((x) => x.pct <= 0);
            return (l.reduce((a, b) => a + b.pct, 0) / Math.max(1, l.length)).toFixed(2);
          })()}%权益`,
      );
      // 敞口不足 vs 择时损失的分解：假设完全跟随池内等权
      console.log(
        `  参考：若按 ${f.avgExposure.toFixed(0)}% 敞口完全跟随同期池内等权，` +
          `年化上限约 ${(((w.label.includes("牛市") ? 52.0 : 19.5) * f.avgExposure) / 100).toFixed(1)}%`,
      );
    }
  }

  if (part === "tf2h") {
    const frozen = { rpsMin: 10, stopMult: 5, trailMult: 6 };
    const mk = (o: Partial<Opts> = {}): Opts => ({
      slotPct: 0.1, mode: "none" as Mode, edge: 0, costBps,
      entryWindow: "dayClose" as const, exitWindow: "all" as const, ...o,
    });
    const full = (over: object, o: Opts) =>
      runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        o,
      );
    const row = (label: string, over: object, o: Opts) => {
      const f = full(over, o);
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
      console.log(
        label.padEnd(26) + `${f.cagr.toFixed(1)}%`.padStart(8) + `${f.dd.toFixed(0)}%`.padStart(7) +
          f.mar.toFixed(2).padStart(7) + m3.mar.toFixed(2).padStart(10) + String(f.entries).padStart(7) +
          `${f.avgExposure.toFixed(0)}%`.padStart(7),
      );
      return { mar: f.mar, m3: m3.mar };
    };

    console.log(`\n=== ${tf} 套用 4H 冻结档（门槛10/止损5/吊灯6/每笔10%）===`);
    console.log(
      "执行口径".padEnd(27) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
        "三段最差".padStart(10) + "开仓".padStart(7) + "敞口".padStart(7),
    );
    const NAME = { all: "每根", dayClose: "仅收盘" } as const;
    for (const ew of ["all", "dayClose"] as const)
      for (const xw of ["all", "dayClose"] as const)
        row(`入场${NAME[ew]} / 出场${NAME[xw]}`, frozen, mk({ entryWindow: ew, exitWindow: xw }));

    // 联合网格：不做逐维贪心，四个维度一起扫，避免顺序搜索偏差。
    // 止损固定 5（4H 上测过 5~8 不敏感，吊灯基本总是先触发）
    console.log("\n=== 2H 自己的最优：门槛 × 吊灯 × 仓位 × 执行 联合网格 ===");
    type Row = {
      label: string; cagr: number; dd: number; mar: number; m3: number; entries: number; exp: number;
    };
    const out: Row[] = [];
    for (const ew of ["all", "dayClose"] as const)
      for (const rpsMin of [0, 10, 20, 30])
        for (const trailMult of [5, 6, 7, 8])
          for (const slotPct of [0.08, 0.1, 0.125]) {
            const over = { rpsMin, stopMult: 5, trailMult };
            const o = mk({ slotPct, entryWindow: ew, exitWindow: "all" as const });
            const f = full(over, o);
            const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
            out.push({
              label: `入${NAME[ew]} 门槛${rpsMin} 吊灯${trailMult} ${(slotPct * 100).toFixed(1)}%`,
              cagr: f.cagr, dd: f.dd, mar: f.mar, m3: m3.mar, entries: f.entries, exp: f.avgExposure,
            });
          }
    const head =
      "配置".padEnd(30) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
      "三段最差".padStart(10) + "开仓".padStart(7) + "敞口".padStart(7);
    const pr = (r: Row) =>
      console.log(
        r.label.padEnd(30) + `${r.cagr.toFixed(1)}%`.padStart(8) + `${r.dd.toFixed(0)}%`.padStart(7) +
          r.mar.toFixed(2).padStart(7) + r.m3.toFixed(2).padStart(10) +
          String(r.entries).padStart(7) + `${r.exp.toFixed(0)}%`.padStart(7),
      );
    console.log("\n--- 按三段最差 MAR 排序 Top 12（稳健性口径）---\n" + head);
    [...out].sort((a, b) => b.m3 - a.m3).slice(0, 12).forEach(pr);
    console.log("\n--- 按全期 MAR 排序 Top 8（全期口径）---\n" + head);
    [...out].sort((a, b) => b.mar - a.mar).slice(0, 8).forEach(pr);
    console.log("\n--- 按 CAGR 排序 Top 5 ---\n" + head);
    [...out].sort((a, b) => b.cagr - a.cagr).slice(0, 5).forEach(pr);
    const best3 = Math.max(...out.map((r) => r.m3));
    console.log(
      `\n  2H 全网格三段最差 MAR 上限 ${best3.toFixed(2)}   ` +
        `4H 冻结档同口径 1.16   ` + (best3 > 1.16 ? "→ 2H 有戏" : "→ 2H 全网格无一档达到 4H 水平"),
    );
  }

  if (part === "tf2h3") {
    // 把 2H 网格里最好看的几档摊到子窗口和样本外，跟 4H 冻结档并排
    const uni4 = await getPreparedUniverse("SMALLFUND", "4h");
    const base4 = baseOf("4h");
    const WIN = [
      ...SEG3,
      { label: "训练前3年", from: "2021-08-24", to: "2024-08-24" },
      { label: "样本外后2年", from: "2024-08-25", to: "2026-08-24" },
      { label: "全期5年", from: SEGMENTS[2].from, to: SEGMENTS[2].to },
    ];
    type Cand = { name: string; tf: Timeframe; over: object; o: Opts };
    const mk = (o: Partial<Opts>): Opts => ({
      slotPct: 0.1, mode: "none" as Mode, edge: 0, costBps,
      entryWindow: "dayClose" as const, exitWindow: "all" as const, ...o,
    });
    const cands: Cand[] = [
      {
        name: "2H 门槛30/吊灯6/8%/每根入",
        tf: "2h", over: { rpsMin: 30, stopMult: 5, trailMult: 6 },
        o: mk({ slotPct: 0.08, entryWindow: "all" }),
      },
      {
        name: "2H 门槛10/吊灯8/8%/每根入",
        tf: "2h", over: { rpsMin: 10, stopMult: 5, trailMult: 8 },
        o: mk({ slotPct: 0.08, entryWindow: "all" }),
      },
      {
        name: "2H 门槛30/吊灯8/10%/每根入",
        tf: "2h", over: { rpsMin: 30, stopMult: 5, trailMult: 8 },
        o: mk({ slotPct: 0.1, entryWindow: "all" }),
      },
      {
        name: "4H 冻结档（对照）",
        tf: "4h", over: { rpsMin: 10, stopMult: 5, trailMult: 6 },
        o: mk({ slotPct: 0.1, entryWindow: "dayClose" }),
      },
    ];
    console.log("\n=== 各档在六个窗口的 CAGR / 回撤 / MAR ===");
    console.log("配置".padEnd(30) + WIN.map((w) => w.label.padStart(20)).join(""));
    for (const c of cands) {
      const u = c.tf === "4h" ? uni4 : uni;
      const b = c.tf === "4h" ? base4 : base;
      const cells = WIN.map((w) => {
        const f = runRotate(
          u,
          { ...b, ...c.over, from: w.from, to: w.to, timeframe: c.tf } as BacktestConfig,
          c.o,
        );
        return `${f.cagr.toFixed(0)}%/${f.dd.toFixed(0)}%/${f.mar.toFixed(2)}`.padStart(20);
      });
      console.log(c.name.padEnd(30) + cells.join(""));
    }
    console.log("\n  读法：三个 SEG3 子段任意一段塌掉，说明全期数字来自单一时段的运气");
  }

  if (part === "tf2h4") {
    const uni4 = await getPreparedUniverse("SMALLFUND", "4h");
    const base4 = baseOf("4h");
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    const cands = [
      { name: "2H 门槛30/吊灯6/8%/每根入", tf: "2h" as Timeframe, over: { rpsMin: 30, stopMult: 5, trailMult: 6 }, slotPct: 0.08, ew: "all" as const },
      { name: "4H 冻结档", tf: "4h" as Timeframe, over: { rpsMin: 10, stopMult: 5, trailMult: 6 }, slotPct: 0.1, ew: "dayClose" as const },
    ];
    const COSTS = [5, 10, 20, 30, 50];
    console.log("\n=== 成本敏感性（全期 CAGR，单边 bps）===");
    console.log("配置".padEnd(30) + COSTS.map((c) => `${c}bps`.padStart(10)).join("") + "开仓".padStart(8) + "每年".padStart(8));
    for (const c of cands) {
      const u = c.tf === "4h" ? uni4 : uni;
      const b = c.tf === "4h" ? base4 : base;
      let entries = 0;
      const cells = COSTS.map((bps) => {
        const f = runRotate(
          u,
          { ...b, ...c.over, from: W.from, to: W.to, timeframe: c.tf } as BacktestConfig,
          { slotPct: c.slotPct, mode: "none" as Mode, edge: 0, costBps: bps, entryWindow: c.ew, exitWindow: "all" as const },
        );
        entries = f.entries;
        return `${f.cagr.toFixed(1)}%`.padStart(10);
      });
      console.log(c.name.padEnd(30) + cells.join("") + String(entries).padStart(8) + (entries / 5).toFixed(0).padStart(8));
    }
  }

  if (part === "tf2h5") {
    // 只动风控与过滤，信号定义（Vegas/MACD）不碰。
    // 之前那版 2H 网格把 stopMult 钉死在 5、止盈从没开过、RSI 阈值和 RS 转弱离场也没扫。
    type Row = {
      label: string; cagr: number; dd: number; mar: number; m3: number; entries: number;
    };
    const out: Row[] = [];
    const run = (label: string, over: object, slotPct: number, ew: "all" | "dayClose") => {
      const o: Opts = {
        slotPct, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: ew, exitWindow: "all" as const,
      };
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        o,
      );
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
      out.push({ label, cagr: f.cagr, dd: f.dd, mar: f.mar, m3: m3.mar, entries: f.entries });
    };

    for (const stopMult of [3, 4, 5, 6])
      for (const trailMult of [5, 6, 8, 10])
        for (const takeProfitR of [null, 3])
          for (const rpsMin of [10, 30])
            for (const slotPct of [0.08, 0.1])
              for (const ew of ["all", "dayClose"] as const)
                run(
                  `止${stopMult} 吊${trailMult} ${takeProfitR ? "盈3R" : "无盈"} 门${rpsMin} ${(slotPct * 100).toFixed(0)}% 入${ew === "all" ? "每根" : "收盘"}`,
                  { stopMult, trailMult, takeProfitR, rpsMin },
                  slotPct,
                  ew,
                );

    const head =
      "配置".padEnd(38) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
      "三段最差".padStart(10) + "开仓".padStart(7);
    const pr = (r: Row) =>
      console.log(
        r.label.padEnd(38) + `${r.cagr.toFixed(1)}%`.padStart(8) + `${r.dd.toFixed(0)}%`.padStart(7) +
          r.mar.toFixed(2).padStart(7) + r.m3.toFixed(2).padStart(10) + String(r.entries).padStart(7),
      );
    console.log(`\n=== 2H 风控×过滤联合网格 ${out.length} 组 ===`);
    console.log("\n--- 按三段最差 MAR（稳健口径，4H 冻结档 = 1.16）---\n" + head);
    [...out].sort((a, b) => b.m3 - a.m3).slice(0, 12).forEach(pr);
    console.log("\n--- 按全期 MAR（4H 冻结档 = 1.53）---\n" + head);
    [...out].sort((a, b) => b.mar - a.mar).slice(0, 8).forEach(pr);
    const b3 = Math.max(...out.map((r) => r.m3));
    const bm = Math.max(...out.map((r) => r.mar));
    console.log(
      `\n  上限：三段最差 ${b3.toFixed(2)}（4H 1.16）  全期 MAR ${bm.toFixed(2)}（4H 1.53）  ` +
        (b3 > 1.16 ? "→ 2H 追平" : "→ 仍无一组达到 4H"),
    );
  }

  if (part === "tf2h6") {
    // 补扫两个过滤旋钮：入场 RSI 阈值、持仓期 RS 转弱离场。
    // 挂在三种代表性底座上，避免只在单一底座上看结论
    const BASES = [
      { name: "止6吊10盈3R门10 10%", over: { stopMult: 6, trailMult: 10, takeProfitR: 3, rpsMin: 10 }, slot: 0.1 },
      { name: "止5吊6无盈门30 8%", over: { stopMult: 5, trailMult: 6, takeProfitR: null, rpsMin: 30 }, slot: 0.08 },
      { name: "止6吊8无盈门30 10%", over: { stopMult: 6, trailMult: 8, takeProfitR: null, rpsMin: 30 }, slot: 0.1 },
    ];
    const head =
      "minRsi / RS离场".padEnd(20) + "CAGR".padStart(8) + "回撤".padStart(7) +
      "MAR".padStart(7) + "三段最差".padStart(10) + "开仓".padStart(7);
    let best3 = 0;
    let bestM = 0;
    for (const b of BASES) {
      console.log(`\n=== 底座 ${b.name} ===\n` + head);
      for (const minRsi of [20, 30, 40])
        for (const rpsExit of [null, 20, 30]) {
          const over = { ...b.over, minRsi, rpsExit };
          const o: Opts = {
            slotPct: b.slot, mode: "none" as Mode, edge: 0, costBps,
            entryWindow: "all" as const, exitWindow: "all" as const,
          };
          const f = runRotate(
            uni,
            { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
            o,
          );
          const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
          best3 = Math.max(best3, m3.mar);
          bestM = Math.max(bestM, f.mar);
          console.log(
            `RSI${minRsi} / ${rpsExit ?? "不离场"}`.padEnd(20) + `${f.cagr.toFixed(1)}%`.padStart(8) +
              `${f.dd.toFixed(0)}%`.padStart(7) + f.mar.toFixed(2).padStart(7) +
              m3.mar.toFixed(2).padStart(10) + String(f.entries).padStart(7),
          );
        }
    }
    console.log(
      `\n  两轮合计上限：三段最差 ${best3.toFixed(2)}（4H 1.16）  全期 MAR ${bestM.toFixed(2)}（4H 1.53）`,
    );
  }

  if (part === "tf2h7") {
    // 诊断：把全网格单独放到熊市段上跑，看 2H 在那一段的天花板。
    // 这是刻意的分段过拟合，只用来区分「参数没调对」和「结构上做不到」
    const uni4 = await getPreparedUniverse("SMALLFUND", "4h");
    const base4 = baseOf("4h");
    const SEG = SEG3[0];
    const scan = (u: typeof uni, b: object, timeframe: Timeframe) => {
      let best = { mar: -99, cagr: 0, dd: 0, label: "" };
      for (const stopMult of [3, 4, 5, 6])
        for (const trailMult of [5, 6, 8, 10])
          for (const takeProfitR of [null, 3])
            for (const rpsMin of [10, 30])
              for (const slotPct of [0.08, 0.1])
                for (const ew of ["all", "dayClose"] as const) {
                  const f = runRotate(
                    u,
                    { ...b, stopMult, trailMult, takeProfitR, rpsMin, from: SEG.from, to: SEG.to, timeframe } as BacktestConfig,
                    { slotPct, mode: "none" as Mode, edge: 0, costBps, entryWindow: ew, exitWindow: "all" as const },
                  );
                  if (f.mar > best.mar)
                    best = {
                      mar: f.mar, cagr: f.cagr, dd: f.dd,
                      label: `止${stopMult} 吊${trailMult} ${takeProfitR ? "盈3R" : "无盈"} 门${rpsMin} ${(slotPct * 100).toFixed(0)}% 入${ew === "all" ? "每根" : "收盘"}`,
                    };
                }
      return best;
    };
    console.log(`\n=== 熊市段 ${SEG.from} → ${SEG.to} 上各自的天花板（256 组分段过拟合）===`);
    const b2 = scan(uni, base, tf);
    const b4 = scan(uni4, base4, "4h");
    console.log(`  2H 最优  ${b2.cagr.toFixed(1)}% / 回撤 ${b2.dd.toFixed(0)}% / MAR ${b2.mar.toFixed(2)}   ${b2.label}`);
    console.log(`  4H 最优  ${b4.cagr.toFixed(1)}% / 回撤 ${b4.dd.toFixed(0)}% / MAR ${b4.mar.toFixed(2)}   ${b4.label}`);
    console.log(`  4H 冻结档在该段（未分段调参）17.0% / 11% / 1.56`);
  }

  if (part === "fullgrid") {
    // 边界：买点定义与 Vegas 开关固定，其余风控/过滤全部放开。
    // 阶段1 只扫 5 个核心维度的全组合，minRsi/rpsExit/执行窗口留给阶段2。
    const EW = (process.argv[5] ?? "dayClose") as "all" | "dayClose";
    type Row = {
      over: Record<string, unknown>; slotPct: number;
      label: string; cagr: number; dd: number; mar: number; m3: number; entries: number;
    };
    const out: Row[] = [];
    let n = 0;
    for (const stopMult of [3, 4, 5, 6, 8])
      for (const trailMult of [4, 5, 6, 7, 8, 10])
        for (const takeProfitR of [null, 2, 3, 4])
          for (const rpsMin of [0, 10, 20, 30, 40])
            for (const slotPct of [0.08, 0.1, 0.125]) {
              const over = { stopMult, trailMult, takeProfitR, rpsMin };
              const o: Opts = {
                slotPct, mode: "none" as Mode, edge: 0, costBps,
                entryWindow: EW, exitWindow: "all" as const,
              };
              const f = runRotate(
                uni,
                { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
                o,
              );
              const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
              out.push({
                over, slotPct,
                label: `止${stopMult} 吊${trailMult} ${takeProfitR ? `盈${takeProfitR}R` : "无盈"} 门${rpsMin} ${(slotPct * 100).toFixed(1)}%`,
                cagr: f.cagr, dd: f.dd, mar: f.mar, m3: m3.mar, entries: f.entries,
              });
              n += 1;
              if (n % 300 === 0) process.stderr.write(`  ...${n}\n`);
            }

    const head =
      "配置".padEnd(34) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
      "三段最差".padStart(10) + "开仓".padStart(7);
    const pr = (r: Row) =>
      console.log(
        r.label.padEnd(34) + `${r.cagr.toFixed(1)}%`.padStart(8) + `${r.dd.toFixed(0)}%`.padStart(7) +
          r.mar.toFixed(2).padStart(7) + r.m3.toFixed(2).padStart(10) + String(r.entries).padStart(7),
      );
    console.log(`\n=== ${tf} 阶段1 全网格 ${out.length} 组（入场${EW === "all" ? "每根" : "仅收盘"}/出场每根，RSI30，不做RS离场）===`);
    console.log("\n--- 按三段最差 MAR（稳健口径）---\n" + head);
    [...out].sort((a, b) => b.m3 - a.m3).slice(0, 15).forEach(pr);
    console.log("\n--- 按全期 MAR ---\n" + head);
    [...out].sort((a, b) => b.mar - a.mar).slice(0, 10).forEach(pr);
    console.log("\n--- 现冻结档所在位置 ---");
    const froz = out.filter((r) => r.label.includes(tf === "1d" ? "止4 吊5" : "止5 吊6 无盈 门10 10.0%"));
    const rank3 = [...out].sort((a, b) => b.m3 - a.m3);
    for (const f of froz) {
      console.log(
        `  ${f.label}  三段最差排名 ${rank3.findIndex((r) => r.label === f.label) + 1}/${out.length}  ` +
          `MAR ${f.mar.toFixed(2)}  三段 ${f.m3.toFixed(2)}`,
      );
    }
  }

  if (part === "verify") {
    // 新候选 vs 冻结档：六个窗口 + 邻域塌陷检查。全期最优可能只是 1800 组里的运气
    const WIN = [
      ...SEG3,
      { label: "训练前3年", from: "2021-08-24", to: "2024-08-24" },
      { label: "样本外后2年", from: "2024-08-25", to: "2026-08-24" },
      { label: "全期5年", from: SEGMENTS[2].from, to: SEGMENTS[2].to },
    ];
    const CANDS: { name: string; over: Record<string, unknown>; slot: number }[] = [
      { name: "★榜首 止8吊10盈3R门30", over: { stopMult: 8, trailMult: 10, takeProfitR: 3, rpsMin: 30 }, slot: 0.125 },
      { name: "  止8吊10盈4R门30", over: { stopMult: 8, trailMult: 10, takeProfitR: 4, rpsMin: 30 }, slot: 0.125 },
      { name: "  止5吊10盈4R门30", over: { stopMult: 5, trailMult: 10, takeProfitR: 4, rpsMin: 30 }, slot: 0.125 },
      { name: "  止6吊10盈4R门30", over: { stopMult: 6, trailMult: 10, takeProfitR: 4, rpsMin: 30 }, slot: 0.125 },
      { name: "  止8吊10无盈门30(去止盈)", over: { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 30 }, slot: 0.125 },
      { name: "  止6吊6盈3R门10", over: { stopMult: 6, trailMult: 6, takeProfitR: 3, rpsMin: 10 }, slot: 0.1 },
      { name: "◎冻结档 止5吊6无盈门10", over: { stopMult: 5, trailMult: 6, takeProfitR: null, rpsMin: 10 }, slot: 0.1 },
    ];
    console.log(`\n=== ${tf} 候选 vs 冻结档：CAGR / 回撤 / MAR ===`);
    console.log("配置".padEnd(28) + WIN.map((w) => w.label.padStart(20)).join(""));
    for (const c of CANDS) {
      const o: Opts = {
        slotPct: c.slot, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: "dayClose" as const, exitWindow: "all" as const,
      };
      const cells = WIN.map((w) => {
        const f = runRotate(
          uni,
          { ...base, ...c.over, from: w.from, to: w.to, timeframe: tf } as BacktestConfig,
          o,
        );
        return `${f.cagr.toFixed(0)}%/${f.dd.toFixed(0)}%/${f.mar.toFixed(2)}`.padStart(20);
      });
      console.log(c.name.padEnd(28) + cells.join(""));
    }

    // 榜首邻域：单维各挪一格，看是不是孤立尖峰
    console.log("\n=== 榜首邻域（单维各挪一格，全期 MAR / 三段最差）===");
    const BASE = { stopMult: 8, trailMult: 10, takeProfitR: 3 as number | null, rpsMin: 30 };
    const nb: [string, Record<string, unknown>, number][] = [
      ["基准 止8吊10盈3R门30 12.5%", BASE, 0.125],
      ["止6", { ...BASE, stopMult: 6 }, 0.125],
      ["止10→无(止8保持)", { ...BASE }, 0.125],
      ["吊8", { ...BASE, trailMult: 8 }, 0.125],
      ["吊12", { ...BASE, trailMult: 12 }, 0.125],
      ["盈2R", { ...BASE, takeProfitR: 2 }, 0.125],
      ["盈4R", { ...BASE, takeProfitR: 4 }, 0.125],
      ["无止盈", { ...BASE, takeProfitR: null }, 0.125],
      ["门20", { ...BASE, rpsMin: 20 }, 0.125],
      ["门40", { ...BASE, rpsMin: 40 }, 0.125],
      ["仓位10%", BASE, 0.1],
      ["仓位15%", BASE, 0.15],
    ];
    for (const [label, over, slot] of nb) {
      const o: Opts = {
        slotPct: slot, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: "dayClose" as const, exitWindow: "all" as const,
      };
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        o,
      );
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
      console.log(
        label.padEnd(28) + `${f.cagr.toFixed(1)}%`.padStart(8) + `${f.dd.toFixed(0)}%`.padStart(7) +
          f.mar.toFixed(2).padStart(8) + m3.mar.toFixed(2).padStart(10) + String(f.entries).padStart(7),
      );
    }
  }

  if (part === "stage2") {
    // 阶段2：在新候选底座上补完 RSI 阈值 / RS 离场 / 两个执行窗口 / 置换 / 仓位
    const BASE = { stopMult: 8, trailMult: 10, takeProfitR: 3, rpsMin: 30 };
    type Row = { label: string; cagr: number; dd: number; mar: number; m3: number; oos: number; entries: number };
    const out: Row[] = [];
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    const add = (label: string, over: Record<string, unknown>, o: Opts) => {
      const f = runRotate(
        uni,
        { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
        o,
      );
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
      const os = runRotate(
        uni,
        { ...base, ...over, from: OOS.from, to: OOS.to, timeframe: tf } as BacktestConfig,
        o,
      );
      out.push({ label, cagr: f.cagr, dd: f.dd, mar: f.mar, m3: m3.mar, oos: os.mar, entries: f.entries });
    };

    for (const minRsi of [20, 30, 40])
      for (const rpsExit of [null, 20, 30])
        for (const ew of ["all", "dayClose"] as const)
          for (const xw of ["all", "dayClose"] as const)
            for (const slotPct of [0.125, 0.15])
              add(
                `RSI${minRsi} ${rpsExit ? `RS离${rpsExit}` : "不离"} 入${ew === "all" ? "每根" : "收盘"} 出${xw === "all" ? "每根" : "收盘"} ${(slotPct * 100).toFixed(1)}%`,
                { ...BASE, minRsi, rpsExit },
                { slotPct, mode: "none" as Mode, edge: 0, costBps, entryWindow: ew, exitWindow: xw },
              );
    for (const edge of [10, 20, 30])
      for (const slotPct of [0.125, 0.15])
        add(
          `置换edge${edge} ${(slotPct * 100).toFixed(1)}%`,
          BASE,
          { slotPct, mode: "rotate" as Mode, edge, costBps, entryWindow: "dayClose" as const, exitWindow: "all" as const },
        );

    const head =
      "配置".padEnd(42) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
      "三段最差".padStart(10) + "样本外".padStart(9) + "开仓".padStart(7);
    const pr = (r: Row) =>
      console.log(
        r.label.padEnd(42) + `${r.cagr.toFixed(1)}%`.padStart(8) + `${r.dd.toFixed(0)}%`.padStart(7) +
          r.mar.toFixed(2).padStart(7) + r.m3.toFixed(2).padStart(10) +
          r.oos.toFixed(2).padStart(9) + String(r.entries).padStart(7),
      );
    console.log(`\n=== ${tf} 阶段2 ${out.length} 组（底座 止8吊10盈3R门30）===`);
    console.log("\n--- 按三段最差 ---\n" + head);
    [...out].sort((a, b) => b.m3 - a.m3).slice(0, 10).forEach(pr);
    console.log("\n--- 按样本外 MAR ---\n" + head);
    [...out].sort((a, b) => b.oos - a.oos).slice(0, 8).forEach(pr);
  }

  if (part === "honest") {
    // 最严格的检验：只在训练期（前3年）跑全网格选参，再看它们在样本外的成绩。
    // 前面那轮全期最优用到了样本外数据选参，这里彻底切断
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    type Row = {
      label: string; over: Record<string, unknown>; slot: number;
      trMar: number; trCagr: number; osMar: number; osCagr: number; osDd: number;
    };
    const out: Row[] = [];
    for (const stopMult of [3, 4, 5, 6, 8])
      for (const trailMult of [4, 5, 6, 7, 8, 10])
        for (const takeProfitR of [null, 2, 3, 4])
          for (const rpsMin of [0, 10, 20, 30, 40])
            for (const slotPct of [0.08, 0.1, 0.125]) {
              const over = { stopMult, trailMult, takeProfitR, rpsMin };
              const o: Opts = {
                slotPct, mode: "none" as Mode, edge: 0, costBps,
                entryWindow: "dayClose" as const, exitWindow: "all" as const,
              };
              const tr = runRotate(uni, { ...base, ...over, ...TR, timeframe: tf } as BacktestConfig, o);
              out.push({
                label: `止${stopMult} 吊${trailMult} ${takeProfitR ? `盈${takeProfitR}R` : "无盈"} 门${rpsMin} ${(slotPct * 100).toFixed(1)}%`,
                over, slot: slotPct,
                trMar: tr.mar, trCagr: tr.cagr, osMar: 0, osCagr: 0, osDd: 0,
              });
            }
    const top = [...out].sort((a, b) => b.trMar - a.trMar).slice(0, 10);
    for (const r of top) {
      const os = runRotate(
        uni,
        { ...base, ...r.over, ...OOS, timeframe: tf } as BacktestConfig,
        { slotPct: r.slot, mode: "none" as Mode, edge: 0, costBps, entryWindow: "dayClose" as const, exitWindow: "all" as const },
      );
      r.osMar = os.mar;
      r.osCagr = os.cagr;
      r.osDd = os.dd;
    }
    console.log(`\n=== ${tf} 只用训练期选参（${out.length} 组），再看样本外 ===`);
    console.log(
      "训练期 Top10".padEnd(34) + "训练MAR".padStart(9) + "训练CAGR".padStart(10) +
        "样本外MAR".padStart(11) + "样本外CAGR".padStart(11) + "样本外回撤".padStart(11),
    );
    for (const r of top)
      console.log(
        r.label.padEnd(34) + r.trMar.toFixed(2).padStart(9) + `${r.trCagr.toFixed(1)}%`.padStart(10) +
          r.osMar.toFixed(2).padStart(11) + `${r.osCagr.toFixed(1)}%`.padStart(11) +
          `${r.osDd.toFixed(0)}%`.padStart(11),
      );
    const med = [...top].map((r) => r.osMar).sort((a, b) => a - b)[Math.floor(top.length / 2)];
    console.log(`\n  训练期 Top10 的样本外 MAR 中位数 ${med.toFixed(2)}`);
    const froz = out.find((r) => r.label === "止5 吊6 无盈 门10 10.0%");
    if (froz) {
      const rank = [...out].sort((a, b) => b.trMar - a.trMar).findIndex((r) => r.label === froz.label) + 1;
      console.log(`  冻结档在训练期排名 ${rank}/${out.length}（训练 MAR ${froz.trMar.toFixed(2)}），样本外 MAR 1.86`);
    }
  }

  if (part === "marginal") {
    // 维度边际分析：不挑单点最优（那是噪声），看每个维度取值的整体分布。
    // 训练期与样本外分别统计中位数，一个维度只有在两边同向才算真信号
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    type Rec = {
      stopMult: number; trailMult: number; takeProfitR: number | null; rpsMin: number; slotPct: number;
      trMar: number; osMar: number;
    };
    const recs: Rec[] = [];
    let n = 0;
    for (const stopMult of [3, 4, 5, 6, 8])
      for (const trailMult of [4, 5, 6, 7, 8, 10])
        for (const takeProfitR of [null, 2, 3, 4])
          for (const rpsMin of [0, 10, 20, 30, 40])
            for (const slotPct of [0.08, 0.1, 0.125]) {
              const over = { stopMult, trailMult, takeProfitR, rpsMin };
              const o: Opts = {
                slotPct, mode: "none" as Mode, edge: 0, costBps,
                entryWindow: "dayClose" as const, exitWindow: "all" as const,
              };
              const tr = runRotate(uni, { ...base, ...over, ...TR, timeframe: tf } as BacktestConfig, o);
              const os = runRotate(uni, { ...base, ...over, ...OOS, timeframe: tf } as BacktestConfig, o);
              recs.push({ stopMult, trailMult, takeProfitR, rpsMin, slotPct, trMar: tr.mar, osMar: os.mar });
              n += 1;
              if (n % 400 === 0) process.stderr.write(`  ...${n}\n`);
            }
    const med = (xs: number[]) => {
      const a = [...xs].sort((x, y) => x - y);
      return a.length === 0 ? 0 : a[Math.floor(a.length / 2)];
    };
    const report = (dim: string, keyOf: (r: Rec) => string) => {
      const g = new Map<string, Rec[]>();
      for (const r of recs) {
        const k = keyOf(r);
        g.set(k, [...(g.get(k) ?? []), r]);
      }
      console.log(`\n--- ${dim} ---`);
      console.log("取值".padEnd(12) + "组数".padStart(7) + "训练MAR中位".padStart(13) + "样本外MAR中位".padStart(14) + "样本外>1.5占比".padStart(15));
      for (const [k, rs] of [...g.entries()].sort()) {
        const good = rs.filter((r) => r.osMar > 1.5).length;
        console.log(
          k.padEnd(12) + String(rs.length).padStart(7) + med(rs.map((r) => r.trMar)).toFixed(2).padStart(13) +
            med(rs.map((r) => r.osMar)).toFixed(2).padStart(14) +
            `${((good / rs.length) * 100).toFixed(0)}%`.padStart(15),
        );
      }
    };
    console.log(`\n=== ${tf} 维度边际分析（${recs.length} 组）===`);
    report("止盈 takeProfitR", (r) => (r.takeProfitR ? `${r.takeProfitR}R` : "无止盈"));
    report("吊灯 trailMult", (r) => `吊${r.trailMult}`);
    report("止损 stopMult", (r) => `止${r.stopMult}`);
    report("门槛 rpsMin", (r) => `门${String(r.rpsMin).padStart(2, "0")}`);
    report("单笔 slotPct", (r) => `${(r.slotPct * 100).toFixed(1)}%`);
  }

  if (part === "slot") {
    const WIN = [
      ...SEG3,
      { label: "训练前3年", from: "2021-08-24", to: "2024-08-24" },
      { label: "样本外后2年", from: "2024-08-25", to: "2026-08-24" },
      { label: "全期5年", from: SEGMENTS[2].from, to: SEGMENTS[2].to },
    ];
    const over = { stopMult: 5, trailMult: 6, takeProfitR: null, rpsMin: 10 };
    console.log(`\n=== ${tf} 冻结档参数下只变单笔仓位：CAGR / 回撤 / MAR ===`);
    console.log("单笔".padEnd(10) + WIN.map((w) => w.label.padStart(20)).join("") + "开仓".padStart(7));
    for (const slotPct of [0.06, 0.08, 0.1, 0.125]) {
      const o: Opts = {
        slotPct, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: "dayClose" as const, exitWindow: "all" as const,
      };
      let entries = 0;
      const cells = WIN.map((w) => {
        const f = runRotate(
          uni,
          { ...base, ...over, from: w.from, to: w.to, timeframe: tf } as BacktestConfig,
          o,
        );
        entries = f.entries;
        return `${f.cagr.toFixed(0)}%/${f.dd.toFixed(0)}%/${f.mar.toFixed(2)}`.padStart(20);
      });
      console.log(`${(slotPct * 100).toFixed(1)}%`.padEnd(10) + cells.join("") + String(entries).padStart(7));
    }
  }

  if (part === "dverify") {
    const WIN = [
      ...SEG3,
      { label: "训练前3年", from: "2021-08-24", to: "2024-08-24" },
      { label: "样本外后2年", from: "2024-08-25", to: "2026-08-24" },
      { label: "全期5年", from: SEGMENTS[2].from, to: SEGMENTS[2].to },
    ];
    const CANDS: { name: string; over: Record<string, unknown>; slot: number; mode: Mode; edge: number }[] = [
      { name: "◎日线冻结档 止4吊5.5无盈门40 12.5%+置换20", over: { stopMult: 4, trailMult: 5.5, takeProfitR: null, rpsMin: 40 }, slot: 0.125, mode: "rotate", edge: 20 },
      { name: "  同上但单笔8%", over: { stopMult: 4, trailMult: 5.5, takeProfitR: null, rpsMin: 40 }, slot: 0.08, mode: "rotate", edge: 20 },
      { name: "  止6吊8无盈门40 8%+置换20", over: { stopMult: 6, trailMult: 8, takeProfitR: null, rpsMin: 40 }, slot: 0.08, mode: "rotate", edge: 20 },
      { name: "★止6吊8盈4R门40 8%+置换20", over: { stopMult: 6, trailMult: 8, takeProfitR: 4, rpsMin: 40 }, slot: 0.08, mode: "rotate", edge: 20 },
      { name: "  止6吊8盈4R门40 8% 不置换", over: { stopMult: 6, trailMult: 8, takeProfitR: 4, rpsMin: 40 }, slot: 0.08, mode: "none", edge: 0 },
      { name: "  止8吊10盈4R门40 8%+置换20", over: { stopMult: 8, trailMult: 10, takeProfitR: 4, rpsMin: 40 }, slot: 0.08, mode: "rotate", edge: 20 },
      { name: "  止6吊8盈4R门30 8%+置换20", over: { stopMult: 6, trailMult: 8, takeProfitR: 4, rpsMin: 30 }, slot: 0.08, mode: "rotate", edge: 20 },
    ];
    console.log(`\n=== 日线候选 vs 冻结档：CAGR / 回撤 / MAR ===`);
    console.log("配置".padEnd(42) + WIN.map((w) => w.label.padStart(19)).join("") + "开仓".padStart(7));
    for (const c of CANDS) {
      const o: Opts = {
        slotPct: c.slot, mode: c.mode, edge: c.edge, costBps,
        entryWindow: "all" as const, exitWindow: "all" as const,
      };
      let entries = 0;
      const cells = WIN.map((w) => {
        const f = runRotate(
          uni,
          { ...base, ...c.over, from: w.from, to: w.to, timeframe: tf } as BacktestConfig,
          o,
        );
        entries = f.entries;
        return `${f.cagr.toFixed(0)}%/${f.dd.toFixed(0)}%/${f.mar.toFixed(2)}`.padStart(19);
      });
      console.log(c.name.padEnd(42) + cells.join("") + String(entries).padStart(7));
    }
  }

  if (part === "quick1h") {
    const uni4 = await getPreparedUniverse("SMALLFUND", "4h");
    const base4 = baseOf("4h");
    const WIN = [
      ...SEG3,
      { label: "训练前3年", from: "2021-08-24", to: "2024-08-24" },
      { label: "样本外后2年", from: "2024-08-25", to: "2026-08-24" },
      { label: "全期5年", from: SEGMENTS[2].from, to: SEGMENTS[2].to },
    ];
    const C: { name: string; tf: Timeframe; over: Record<string, unknown>; slot: number; ew: "all" | "dayClose" }[] = [
      { name: "1H 套4H冻结档 入收盘", tf: "1h", over: { stopMult: 5, trailMult: 6, takeProfitR: null, rpsMin: 10 }, slot: 0.1, ew: "dayClose" },
      { name: "1H 套4H冻结档 入每根", tf: "1h", over: { stopMult: 5, trailMult: 6, takeProfitR: null, rpsMin: 10 }, slot: 0.1, ew: "all" },
      { name: "1H 宽风控 止8吊10 门30 8%", tf: "1h", over: { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 30 }, slot: 0.08, ew: "all" },
      { name: "1H 宽风控+盈4R 8%", tf: "1h", over: { stopMult: 8, trailMult: 10, takeProfitR: 4, rpsMin: 30 }, slot: 0.08, ew: "all" },
      { name: "1H 止6吊8 门30 10% 入每根", tf: "1h", over: { stopMult: 6, trailMult: 8, takeProfitR: null, rpsMin: 30 }, slot: 0.1, ew: "all" },
      { name: "◎4H 冻结档（对照）", tf: "4h", over: { stopMult: 5, trailMult: 6, takeProfitR: null, rpsMin: 10 }, slot: 0.1, ew: "dayClose" },
    ];
    console.log("\n=== 1H 快速基线 vs 4H 冻结档：CAGR / 回撤 / MAR ===");
    console.log("配置".padEnd(30) + WIN.map((w) => w.label.padStart(19)).join("") + "开仓".padStart(7));
    for (const c of C) {
      const u = c.tf === "4h" ? uni4 : uni;
      const b = c.tf === "4h" ? base4 : base;
      const o: Opts = {
        slotPct: c.slot, mode: "none" as Mode, edge: 0, costBps,
        entryWindow: c.ew, exitWindow: "all" as const,
      };
      let entries = 0;
      const cells = WIN.map((w) => {
        const f = runRotate(u, { ...b, ...c.over, from: w.from, to: w.to, timeframe: c.tf } as BacktestConfig, o);
        entries = f.entries;
        return `${f.cagr.toFixed(0)}%/${f.dd.toFixed(0)}%/${f.mar.toFixed(2)}`.padStart(19);
      });
      console.log(c.name.padEnd(30) + cells.join("") + String(entries).padStart(7));
    }
  }

  if (part === "drot") {
    // 日线补置换维度：grid2 把 mode 钉死在 none，而日线冻结档本来带 weakest+edge20
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    const ROWS: { label: string; over: Record<string, unknown>; o: Opts }[] = [];
    const push = (label: string, over: Record<string, unknown>, slotPct: number, mode: Mode, edge: number) =>
      ROWS.push({
        label, over,
        o: { slotPct, mode, edge, costBps, entryWindow: "all" as const, exitWindow: "all" as const },
      });
    const NEW = { stopMult: 4, trailMult: 8, takeProfitR: 3, rpsMin: 10 };
    push("网格最优 止4吊8盈3R门10 12.5% 不置换", NEW, 0.125, "none", 0);
    for (const edge of [0, 10, 20, 30]) push(`  同上 + 置换 edge${edge}`, NEW, 0.125, "weakest", edge);
    const OLD = { stopMult: 4, trailMult: 5.5, takeProfitR: null, rpsMin: 40 };
    push("日线原冻结档 止4吊5.5无盈门40 12.5%+置换20", OLD, 0.125, "weakest", 20);
    push("  原冻结档但不置换", OLD, 0.125, "none", 0);

    console.log(`\n=== 日线：置换维度补测（成本 ${costBps}bps）===`);
    console.log(
      "配置".padEnd(42) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
        "三段最差".padStart(10) + "熊市段".padStart(14) + "训练".padStart(7) + "样本外".padStart(8) + "开仓".padStart(7),
    );
    for (const r of ROWS) {
      const f = runRotate(uni, { ...base, ...r.over, ...W, timeframe: tf } as BacktestConfig, r.o);
      const segs = [0, 1, 2].map((i) => runRotate(uni, cfg3(i, r.over), r.o));
      const m3 = worst(segs);
      const tr = runRotate(uni, { ...base, ...r.over, ...TR, timeframe: tf } as BacktestConfig, r.o);
      const os = runRotate(uni, { ...base, ...r.over, ...OOS, timeframe: tf } as BacktestConfig, r.o);
      console.log(
        r.label.padEnd(42) + `${f.cagr.toFixed(1)}%`.padStart(8) + `${f.dd.toFixed(0)}%`.padStart(7) +
          f.mar.toFixed(2).padStart(7) + m3.mar.toFixed(2).padStart(10) +
          `${segs[0].cagr.toFixed(0)}%/${segs[0].mar.toFixed(2)}`.padStart(14) +
          tr.mar.toFixed(2).padStart(7) + os.mar.toFixed(2).padStart(8) +
          String(f.entries).padStart(7),
      );
    }
  }

  if (part === "verify2") {
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    const mk = (slotPct: number, ew: "all" | "dayClose"): Opts => ({
      slotPct, mode: "none" as Mode, edge: 0, costBps,
      entryWindow: ew, exitWindow: "all" as const,
    });
    const CANDS = [
      { label: "★新榜首 止8吊10盈3R门0 8%收盘", over: { stopMult: 8, trailMult: 10, takeProfitR: 3, rpsMin: 0 }, o: mk(0.08, "dayClose") },
      { label: "  次优 止8吊10盈3R门10 8%收盘", over: { stopMult: 8, trailMult: 10, takeProfitR: 3, rpsMin: 10 }, o: mk(0.08, "dayClose") },
      { label: "  无止盈版 止8吊10门10 8%收盘", over: { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 10 }, o: mk(0.08, "dayClose") },
      { label: "  旧冻结档 止5吊6门10 10%收盘", over: { stopMult: 5, trailMult: 6, takeProfitR: null, rpsMin: 10 }, o: mk(0.1, "dayClose") },
    ];

    console.log(`\n=== A. 成本敏感性（全期 CAGR / MAR / 三段最差）===`);
    console.log("配置".padEnd(32) + [0, 10, 20, 30, 50].map((b) => `${b}bps`.padStart(20)).join(""));
    for (const c of CANDS) {
      const cells = [0, 10, 20, 30, 50].map((bps) => {
        const o = { ...c.o, costBps: bps };
        const f = runRotate(uni, { ...base, ...c.over, ...W, timeframe: tf } as BacktestConfig, o);
        const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, c.over), o)));
        return `${f.cagr.toFixed(1)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(20);
      });
      console.log(c.label.padEnd(32) + cells.join(""));
    }

    console.log(`\n=== B. 利润集中度与交易画像（10bps）===`);
    console.log(
      "配置".padEnd(32) + "开仓".padStart(6) + "胜率".padStart(7) + "前5笔占毛利".padStart(13) +
        "前10笔".padStart(9) + "持仓中位".padStart(10) + "敞口".padStart(7) + "年均成交".padStart(9),
    );
    for (const c of CANDS) {
      const f = runRotate(uni, { ...base, ...c.over, ...W, timeframe: tf } as BacktestConfig, c.o);
      const wins = f.lotPnl.filter((x) => x.pct > 0).sort((a, b) => b.pct - a.pct);
      const gross = wins.reduce((a, b) => a + b.pct, 0);
      const top = (k: number) => (gross > 0 ? (wins.slice(0, k).reduce((a, b) => a + b.pct, 0) / gross) * 100 : 0);
      const hc = [...f.holdCounts].sort((a, b) => a - b);
      console.log(
        c.label.padEnd(32) + String(f.entries).padStart(6) +
          `${((wins.length / Math.max(1, f.lotPnl.length)) * 100).toFixed(0)}%`.padStart(7) +
          `${top(5).toFixed(0)}%`.padStart(13) + `${top(10).toFixed(0)}%`.padStart(9) +
          String(hc[Math.floor(hc.length / 2)]).padStart(10) +
          `${f.avgExposure.toFixed(0)}%`.padStart(7) +
          f.tradesPerYear.toFixed(0).padStart(9),
      );
    }

    console.log(`\n=== C. 邻域：止损 × 吊灯（盈3R 门0 8% 收盘入）格式 CAGR/回撤/MAR/三段最差 ===`);
    const trails = [6, 8, 10, 12];
    console.log("止损".padEnd(7) + trails.map((t) => `吊灯${t}`.padStart(22)).join(""));
    for (const stopMult of [4, 5, 6, 7, 8, 10]) {
      const cells = trails.map((trailMult) => {
        const over = { stopMult, trailMult, takeProfitR: 3, rpsMin: 0 };
        const o = mk(0.08, "dayClose");
        const f = runRotate(uni, { ...base, ...over, ...W, timeframe: tf } as BacktestConfig, o);
        const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
        return `${f.cagr.toFixed(1)}/${f.dd.toFixed(0)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(22);
      });
      console.log(`止${stopMult}`.padEnd(7) + cells.join(""));
    }

    console.log(`\n=== D. 止盈档与仓位（止8 吊10 门0 收盘入）===`);
    console.log("止盈".padEnd(10) + [0.06, 0.08, 0.1, 0.125].map((s) => `${(s * 100).toFixed(1)}%`.padStart(22)).join(""));
    for (const takeProfitR of [null, 2, 3, 4, 6]) {
      const cells = [0.06, 0.08, 0.1, 0.125].map((slotPct) => {
        const over = { stopMult: 8, trailMult: 10, takeProfitR, rpsMin: 0 };
        const o = mk(slotPct, "dayClose");
        const f = runRotate(uni, { ...base, ...over, ...W, timeframe: tf } as BacktestConfig, o);
        const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
        return `${f.cagr.toFixed(1)}/${f.dd.toFixed(0)}/${f.mar.toFixed(2)}/${m3.mar.toFixed(2)}`.padStart(22);
      });
      console.log(`${takeProfitR ? `${takeProfitR}R` : "无止盈"}`.padEnd(10) + cells.join(""));
    }

    console.log(`\n=== E. 分窗口明细 ===`);
    for (const c of CANDS) {
      const segs = [0, 1, 2].map((i) => runRotate(uni, cfg3(i, c.over), c.o));
      const tr = runRotate(uni, { ...base, ...c.over, ...TR, timeframe: tf } as BacktestConfig, c.o);
      const os = runRotate(uni, { ...base, ...c.over, ...OOS, timeframe: tf } as BacktestConfig, c.o);
      const f = runRotate(uni, { ...base, ...c.over, ...W, timeframe: tf } as BacktestConfig, c.o);
      console.log(`\n${c.label}`);
      segs.forEach((sg, i) =>
        console.log(`  ${SEG3[i].label}  ${sg.cagr.toFixed(1)}% / ${sg.dd.toFixed(1)}% / ${sg.mar.toFixed(2)}`),
      );
      console.log(`  训练3年  ${tr.cagr.toFixed(1)}% / ${tr.dd.toFixed(1)}% / ${tr.mar.toFixed(2)}`);
      console.log(`  样本外2年 ${os.cagr.toFixed(1)}% / ${os.dd.toFixed(1)}% / ${os.mar.toFixed(2)}`);
      console.log(`  全期5年  ${f.cagr.toFixed(1)}% / ${f.dd.toFixed(1)}% / ${f.mar.toFixed(2)}`);
    }
  }

  if (part === "rsi") {
    // grid2 的 576 组没覆盖 requireRsi/minRsi 和 rpsExit：这两维只在补数据之前搜过，
    // 而重定档的教训正是「同一网格因少了五年历史，止损/吊灯/门槛三项全部反向」，
    // 没理由认为这两维免疫。交叉扫而非各扫一遍：两者都在过滤弱势票，可能互相替代。
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    const FROZEN = { stopMult: 8, trailMult: 10, takeProfitR: null as number | null, rpsMin: 0 };
    const O: Opts = {
      slotPct: 0.08, mode: "none" as Mode, edge: 0, costBps,
      entryWindow: "dayClose" as const, exitWindow: "all" as const,
    };

    // minRsi 只在 requireRsi 为真时参与判定，所以「关闭闸门」得走 requireRsi: false。
    const RSI_GATES = [
      { label: "RSI 关", over: { requireRsi: false } },
      { label: "RSI≥20", over: { requireRsi: true, minRsi: 20 } },
      { label: "RSI≥30", over: { requireRsi: true, minRsi: 30 } },
      { label: "RSI≥40", over: { requireRsi: true, minRsi: 40 } },
      { label: "RSI≥50", over: { requireRsi: true, minRsi: 50 } },
    ];
    const RPS_EXITS: (number | null)[] = [null, 10, 20, 30];

    type R = { label: string; cagr: number; dd: number; mar: number; m3: number; tr: number; os: number; entries: number };
    const out: R[] = [];
    for (const gate of RSI_GATES)
      for (const rpsExit of RPS_EXITS) {
        const over = { ...FROZEN, ...gate.over, rpsExit };
        const f = runRotate(uni, { ...base, ...over, ...W, timeframe: tf } as BacktestConfig, O);
        const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), O)));
        const tr = runRotate(uni, { ...base, ...over, ...TR, timeframe: tf } as BacktestConfig, O);
        const os = runRotate(uni, { ...base, ...over, ...OOS, timeframe: tf } as BacktestConfig, O);
        out.push({
          label: `${gate.label}  RPS出场${rpsExit ?? "关"}`,
          cagr: f.cagr, dd: f.dd, mar: f.mar, m3: m3.mar, tr: tr.mar, os: os.mar, entries: f.entries,
        });
      }

    const head =
      "配置".padEnd(24) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
      "三段最差".padStart(10) + "训练".padStart(8) + "样本外".padStart(9) + "开仓".padStart(7);
    const pr = (r: R) =>
      console.log(
        (r.label + (r.label === "RSI≥30  RPS出场关" ? " ←冻结档" : "")).padEnd(24) +
          `${r.cagr.toFixed(1)}%`.padStart(8) + `${r.dd.toFixed(0)}%`.padStart(7) +
          r.mar.toFixed(2).padStart(7) + r.m3.toFixed(2).padStart(10) +
          r.tr.toFixed(2).padStart(8) + r.os.toFixed(2).padStart(9) + String(r.entries).padStart(7),
      );

    console.log(`\n=== ${tf} 补搜 RSI 闸门 × RPS 出场（其余为冻结档：止8 吊10 无盈 门0 8% 收盘入，成本 ${costBps}bps）===`);
    console.log("\n--- 全部 20 组，按三段最差排序 ---\n" + head);
    [...out].sort((a, b) => b.m3 - a.m3).forEach(pr);

    const frozen = out.find((r) => r.label === "RSI≥30  RPS出场关")!;
    const rank = [...out].sort((a, b) => b.m3 - a.m3).findIndex((r) => r.label === frozen.label) + 1;
    console.log(`\n冻结档在三段最差榜排第 ${rank}/${out.length}`);

    // 「RSI 关」和「RSI≥30」的开仓数只差 1（199 vs 200），却差 0.17 的三段最差。
    // 净开仓数看不出真实差异：满仓放弃新信号，滤掉一个弱信号会把坑位让给后面的票。
    // 所以按票统计成交笔数的对称差——差异只有几笔，那 0.17 就是运气，不是闸门的功劳。
    const legsOf = (over: Record<string, unknown>) => {
      const r = runRotate(uni, { ...base, ...FROZEN, ...over, ...W, timeframe: tf } as BacktestConfig, O);
      const m = new Map<string, number>();
      for (const l of r.lotPnl) m.set(l.symbol, (m.get(l.symbol) ?? 0) + 1);
      return { r, m };
    };
    const gateOn = legsOf({ requireRsi: true, minRsi: 30, rpsExit: null });
    const gateOff = legsOf({ requireRsi: false, rpsExit: null });
    let overlap = 0;
    let delta = 0;
    for (const name of new Set([...gateOn.m.keys(), ...gateOff.m.keys()])) {
      const a = gateOn.m.get(name) ?? 0;
      const b = gateOff.m.get(name) ?? 0;
      overlap += Math.min(a, b);
      delta += Math.abs(a - b);
    }
    console.log(
      `\nRSI≥30 vs RSI关：平仓 ${gateOn.r.lotPnl.length} vs ${gateOff.r.lotPnl.length} 笔，` +
        `按票重叠 ${overlap} 笔，差异 ${delta} 笔`,
    );
  }

  if (part === "edge") {
    // grid2 的冠军在 stopMult / trailMult / slotPct 上都落在网格边缘（8 / 10 / 8%），
    // 边界解说明范围不够宽，最优可能在外面。这一轮把三个参数往外推，并补上吊灯
    // 9 / 11 两个邻居——旧数据下「吊灯 10 是孤峰」的结论从没在新数据上复核过。
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    // 每个周期的固定维沿用它自己的定档，网格只动止损/吊灯/仓位三维。
    // 吊灯距离是 trailMult × ATR(周期)，而 ATR 大致按 √时间 缩放：ATR(4H) ≈ 2×ATR(1H)。
    // 所以 4H 的「吊10」等效于 20 个 1H-ATR，1H 想达到同样宽度得搜到 20 以上——
    // grid2 的上界卡在 10，等于从没让 1H 试过和 4H 一样宽的止损。
    const EDGE: Record<string, {
      fixed: Record<string, unknown>; o: Omit<Opts, "slotPct">;
      stops: number[]; trails: number[]; slots: number[]; base: [number, number, number];
    }> = {
      "4h": {
        fixed: { takeProfitR: null, rpsMin: 0, requireRsi: true, minRsi: 30, rpsExit: null },
        o: { mode: "none", edge: 0, costBps, entryWindow: "dayClose", exitWindow: "all" },
        stops: [6, 7, 8, 9, 10, 12, 15], trails: [8, 9, 10, 11, 12, 15, 20],
        slots: [0.04, 0.05, 0.06, 0.08, 0.1], base: [8, 10, 0.08],
      },
      "2h": {
        fixed: { takeProfitR: null, rpsMin: 30, requireRsi: false, rpsExit: 10 },
        o: { mode: "none", edge: 0, costBps, entryWindow: "dayClose", exitWindow: "all" },
        // 仓位曾在 13% 上界仍单调上行，往上追到 25% 后确认 13% 是真峰：
        // 15%:0.62 → 18%:0.43 → 20%:0.34 → 25%:0.38，边界解已排除。
        stops: [6, 8, 10, 12, 15], trails: [8, 10, 12, 14, 16, 20, 25],
        slots: [0.06, 0.08, 0.1, 0.125, 0.15, 0.2], base: [8, 10, 0.125],
      },
      "1h": {
        fixed: { takeProfitR: 3, rpsMin: 30, requireRsi: true, minRsi: 50, rpsExit: 30 },
        o: { mode: "weakest", edge: 0, costBps, entryWindow: "all", exitWindow: "dayClose" },
        stops: [6, 8, 12, 16, 20], trails: [8, 12, 16, 20, 25, 30, 40],
        slots: [0.08, 0.1, 0.125], base: [6, 8, 0.125],
      },
      "1d": {
        fixed: { takeProfitR: 3, rpsMin: 10, requireRsi: false, rpsExit: 10 },
        o: { mode: "none", edge: 0, costBps, entryWindow: "dayClose", exitWindow: "all" },
        stops: [2, 3, 4, 5, 6, 8], trails: [4, 5, 6, 7, 8, 10, 12],
        slots: [0.08, 0.1, 0.125, 0.15], base: [4, 8, 0.125],
      },
    };
    const E = EDGE[tf];
    const FIXED = E.fixed;
    type R = {
      label: string; onEdge: boolean;
      cagr: number; dd: number; mar: number; m3: number; bear: number; bearCagr: number;
      tr: number; os: number; entries: number;
    };
    const STOPS = E.stops;
    const TRAILS = E.trails;
    const SLOTS = E.slots;
    const total = STOPS.length * TRAILS.length * SLOTS.length;
    const out: R[] = [];
    let n = 0;
    for (const stopMult of STOPS)
      for (const trailMult of TRAILS)
        for (const slotPct of SLOTS) {
          const over = { ...FIXED, stopMult, trailMult };
          const o: Opts = { slotPct, ...E.o };
          const f = runRotate(uni, { ...base, ...over, ...W, timeframe: tf } as BacktestConfig, o);
          const segs = [0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o));
          const tr = runRotate(uni, { ...base, ...over, ...TR, timeframe: tf } as BacktestConfig, o);
          const os = runRotate(uni, { ...base, ...over, ...OOS, timeframe: tf } as BacktestConfig, o);
          out.push({
            label: `止${stopMult} 吊${trailMult} ${(slotPct * 100).toFixed(0)}%`,
            onEdge: stopMult === E.base[0] && trailMult === E.base[1] && Math.abs(slotPct - E.base[2]) < 1e-9,
            cagr: f.cagr, dd: f.dd, mar: f.mar, m3: worst(segs).mar,
            bear: segs[0].mar, bearCagr: segs[0].cagr, tr: tr.mar, os: os.mar, entries: f.entries,
          });
          n += 1;
          if (n % 20 === 0) process.stderr.write(`  ...${n}/${total}\n`);
        }

    const head =
      "配置".padEnd(22) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
      "三段最差".padStart(10) + "熊市段".padStart(14) + "训练".padStart(8) + "样本外".padStart(9) + "开仓".padStart(7);
    const pr = (r: R) =>
      console.log(
        (r.label + (r.onEdge ? " ←原定档" : "")).padEnd(22) +
          `${r.cagr.toFixed(1)}%`.padStart(8) + `${r.dd.toFixed(0)}%`.padStart(7) +
          r.mar.toFixed(2).padStart(7) + r.m3.toFixed(2).padStart(10) +
          `${r.bearCagr.toFixed(0)}%/${r.bear.toFixed(2)}`.padStart(14) +
          r.tr.toFixed(2).padStart(8) + r.os.toFixed(2).padStart(9) + String(r.entries).padStart(7),
      );

    console.log(`\n=== ${tf} 边界扩展 ${out.length} 组（止${STOPS.join("/")} × 吊${TRAILS.join("/")} × ${SLOTS.map((s) => (s * 100).toFixed(0)).join("/")}%）===`);
    const byM3 = [...out].sort((a, b) => b.m3 - a.m3);
    console.log("\n--- 按三段最差 Top15 ---\n" + head);
    byM3.slice(0, 15).forEach(pr);
    const ei = byM3.findIndex((r) => r.onEdge);
    console.log(`\n原定档「止${E.base[0]} 吊${E.base[1]} ${(E.base[2] * 100).toFixed(0)}%」排第 ${ei + 1}/${out.length}`);

    // 一维剖面：看每个参数是不是还在往外单调走，只要还在涨就说明范围仍然不够。
    for (const [name, vals, key] of [
      ["止损", STOPS, "止"], ["吊灯", TRAILS, "吊"], ["每笔", SLOTS.map((s) => Number((s * 100).toFixed(0))), "%"],
    ] as const) {
      const line = vals.map((v) => {
        // 尾随空格是必需的：「吊1 」不能匹配「吊10 」「吊12 」。
        const pat = key === "%" ? `${v}%` : `${key}${v} `;
        const hit = out.filter((r) => (key === "%" ? r.label.endsWith(pat) : r.label.includes(pat)));
        const best = Math.max(...hit.map((r) => r.m3));
        return `${v}${key === "%" ? "%" : ""}:${best.toFixed(2)}`;
      });
      console.log(`${name}剖面（各档最好的三段最差）: ${line.join("  ")}`);
    }
  }

  if (part === "grid2") {
    // 补数据 + 日频口径后重搜。旧的 4H 参数全部是在「缺席 2022 跌段」的数据上选的
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    type R = {
      over: Record<string, unknown>; o: Opts; label: string;
      cagr: number; dd: number; mar: number; m3: number; bear: number; bearCagr: number;
      entries: number; exp: number;
    };
    const out: R[] = [];
    let n = 0;
    for (const stopMult of [4, 5, 6, 8])
      for (const trailMult of [5, 6, 8, 10])
        for (const takeProfitR of [null, 3])
          for (const rpsMin of [0, 10, 30])
            for (const slotPct of [0.08, 0.1, 0.125])
              for (const ew of ["all", "dayClose"] as const) {
                const over = { stopMult, trailMult, takeProfitR, rpsMin };
                const o: Opts = {
                  slotPct, mode: "none" as Mode, edge: 0, costBps,
                  entryWindow: ew, exitWindow: "all" as const,
                };
                const f = runRotate(uni, { ...base, ...over, ...W, timeframe: tf } as BacktestConfig, o);
                const segs = [0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o));
                const m3 = worst(segs);
                out.push({
                  over, o,
                  label: `止${stopMult} 吊${trailMult} ${takeProfitR ? `盈${takeProfitR}R` : "无盈"} 门${rpsMin} ${(slotPct * 100).toFixed(1)}% 入${ew === "all" ? "每根" : "收盘"}`,
                  cagr: f.cagr, dd: f.dd, mar: f.mar, m3: m3.mar,
                  bear: segs[0].mar, bearCagr: segs[0].cagr,
                  entries: f.entries, exp: f.avgExposure,
                });
                n += 1;
                if (n % 100 === 0) process.stderr.write(`  ...${n}/576\n`);
              }
    const head =
      "配置".padEnd(40) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
      "三段最差".padStart(10) + "熊市段".padStart(14) + "开仓".padStart(7) + "敞口".padStart(7);
    const pr = (r: R) =>
      console.log(
        r.label.padEnd(40) + `${r.cagr.toFixed(1)}%`.padStart(8) + `${r.dd.toFixed(0)}%`.padStart(7) +
          r.mar.toFixed(2).padStart(7) + r.m3.toFixed(2).padStart(10) +
          `${r.bearCagr.toFixed(0)}%/${r.bear.toFixed(2)}`.padStart(14) +
          String(r.entries).padStart(7) + `${r.exp.toFixed(0)}%`.padStart(7),
      );
    console.log(`\n=== ${tf} 重搜 ${out.length} 组（补数据后 + 日频口径，成本 ${costBps}bps）===`);
    console.log("\n--- 按三段最差（唯一跨越 2022 的判据）---\n" + head);
    const byM3 = [...out].sort((a, b) => b.m3 - a.m3);
    byM3.slice(0, 10).forEach(pr);
    console.log("\n--- 按全期 MAR ---\n" + head);
    [...out].sort((a, b) => b.mar - a.mar).slice(0, 8).forEach(pr);
    console.log("\n--- 按 CAGR ---\n" + head);
    [...out].sort((a, b) => b.cagr - a.cagr).slice(0, 6).forEach(pr);

    // 旧冻结档在新数据下排第几
    const idx = byM3.findIndex((r) => r.label === "止5 吊6 无盈 门10 10.0% 入收盘");
    console.log(`\n旧冻结档「止5 吊6 无盈 门10 10% 入收盘」在三段最差榜排第 ${idx + 1}/${out.length}`);

    console.log("\n--- 三段最差 Top6 的训练/样本外 ---");
    console.log("配置".padEnd(40) + "训练MAR".padStart(9) + "样本外MAR".padStart(11));
    for (const r of byM3.slice(0, 6)) {
      const tr = runRotate(uni, { ...base, ...r.over, ...TR, timeframe: tf } as BacktestConfig, r.o);
      const os = runRotate(uni, { ...base, ...r.over, ...OOS, timeframe: tf } as BacktestConfig, r.o);
      console.log(r.label.padEnd(40) + tr.mar.toFixed(2).padStart(9) + os.mar.toFixed(2).padStart(11));
    }
  }

  if (part === "best3") {
    // grid2 的 576 组只动了 6 维，把 RSI 闸门、RPS 出场、置换、出场窗口四维锁死在默认值上
    // （RSI≥30 / 出场关 / 不置换 / all）。这里拿各周期自己的 grid2 冠军当基准，补齐那四维。
    //
    // 这是坐标下降，不是联合搜索：576×160 跑不动。代价是若某两维互相依赖，可能停在局部最优。
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };

    // 各周期 grid2「按三段最差」排第一的那组
    const CHAMPS: Record<string, { over: Record<string, unknown>; slotPct: number; entryWindow: "all" | "dayClose"; label: string }> = {
      "4h": { over: { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 0 }, slotPct: 0.08, entryWindow: "dayClose", label: "止8 吊10 无盈 门0 8% 入收盘" },
      "2h": { over: { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 30 }, slotPct: 0.125, entryWindow: "dayClose", label: "止8 吊10 无盈 门30 12.5% 入收盘" },
      "1h": { over: { stopMult: 6, trailMult: 8, takeProfitR: 3, rpsMin: 30 }, slotPct: 0.125, entryWindow: "all", label: "止6 吊8 盈3R 门30 12.5% 入每根" },
      "1d": { over: { stopMult: 4, trailMult: 8, takeProfitR: 3, rpsMin: 10 }, slotPct: 0.125, entryWindow: "dayClose", label: "止4 吊8 盈3R 门10 12.5% 入收盘" },
    };
    const champ = CHAMPS[tf];

    // minRsi 只在 requireRsi 为真时参与判定，关闸门得走 requireRsi: false
    const RSI_GATES = [
      { label: "RSI关", over: { requireRsi: false } },
      { label: "RSI≥20", over: { requireRsi: true, minRsi: 20 } },
      { label: "RSI≥30", over: { requireRsi: true, minRsi: 30 } },
      { label: "RSI≥40", over: { requireRsi: true, minRsi: 40 } },
      { label: "RSI≥50", over: { requireRsi: true, minRsi: 50 } },
    ];
    const RPS_EXITS: (number | null)[] = [null, 10, 20, 30];
    const ROTS: { label: string; mode: Mode; edge: number }[] = [
      { label: "不置换", mode: "none", edge: 0 },
      { label: "置换+0", mode: "weakest", edge: 0 },
      { label: "置换+10", mode: "weakest", edge: 10 },
      { label: "置换+20", mode: "weakest", edge: 20 },
    ];
    const EXITS = ["all", "dayClose"] as const;

    type R = {
      label: string; isBase: boolean;
      cagr: number; dd: number; mar: number; m3: number; bear: number; bearCagr: number;
      tr: number; os: number; entries: number;
    };
    const out: R[] = [];
    let n = 0;
    for (const gate of RSI_GATES)
      for (const rpsExit of RPS_EXITS)
        for (const rot of ROTS)
          for (const xw of EXITS) {
            const over = { ...champ.over, ...gate.over, rpsExit };
            const o: Opts = {
              slotPct: champ.slotPct, mode: rot.mode, edge: rot.edge, costBps,
              entryWindow: champ.entryWindow, exitWindow: xw,
            };
            const f = runRotate(uni, { ...base, ...over, ...W, timeframe: tf } as BacktestConfig, o);
            const segs = [0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o));
            const tr = runRotate(uni, { ...base, ...over, ...TR, timeframe: tf } as BacktestConfig, o);
            const os = runRotate(uni, { ...base, ...over, ...OOS, timeframe: tf } as BacktestConfig, o);
            out.push({
              label: `${gate.label} 出场${rpsExit ?? "关"} ${rot.label} 平${xw === "all" ? "每根" : "收盘"}`,
              isBase: gate.label === "RSI≥30" && rpsExit === null && rot.label === "不置换" && xw === "all",
              cagr: f.cagr, dd: f.dd, mar: f.mar, m3: worst(segs).mar,
              bear: segs[0].mar, bearCagr: segs[0].cagr, tr: tr.mar, os: os.mar, entries: f.entries,
            });
            n += 1;
            if (n % 20 === 0) process.stderr.write(`  ...${n}/160\n`);
          }

    const head =
      "配置".padEnd(34) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
      "三段最差".padStart(10) + "熊市段".padStart(14) + "训练".padStart(8) + "样本外".padStart(9) + "开仓".padStart(7);
    const pr = (r: R) =>
      console.log(
        (r.label + (r.isBase ? " ←grid2基准" : "")).padEnd(34) +
          `${r.cagr.toFixed(1)}%`.padStart(8) + `${r.dd.toFixed(0)}%`.padStart(7) +
          r.mar.toFixed(2).padStart(7) + r.m3.toFixed(2).padStart(10) +
          `${r.bearCagr.toFixed(0)}%/${r.bear.toFixed(2)}`.padStart(14) +
          r.tr.toFixed(2).padStart(8) + r.os.toFixed(2).padStart(9) + String(r.entries).padStart(7),
      );

    console.log(`\n=== ${tf} 补搜剩余四维 ${out.length} 组（基准：${champ.label}，成本 ${costBps}bps）===`);
    const byM3 = [...out].sort((a, b) => b.m3 - a.m3);
    console.log("\n--- 按三段最差 Top12 ---\n" + head);
    byM3.slice(0, 12).forEach(pr);

    const bi = byM3.findIndex((r) => r.isBase);
    console.log(`\ngrid2 基准（RSI≥30 出场关 不置换 平每根）在三段最差榜排第 ${bi + 1}/${out.length}`);
    console.log("\n--- grid2 基准本身 ---\n" + head);
    pr(byM3[bi]);

    // 置换从没进过 Top12，但要说清它差多少，得看每档自己的最好成绩而不是缺席事实。
    console.log("\n--- 各置换档的最好成绩（其余三维各自取最优）---\n" + head);
    for (const rot of ROTS) {
      const best = byM3.find((r) => r.label.includes(rot.label));
      if (best) pr(best);
    }
  }

  if (part === "stale") {
    // 数据在窗口内就断掉的票（抓取不全，非退市）：断点之后 leg.view 恒为 null，
    // 持仓既不会触发出场也不再变价，被冻结在最后收盘价上占着槽位到回测结束。
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    const OVER = { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 0, requireRsi: true, minRsi: 30, rpsExit: null };
    const O: Opts = {
      slotPct: 0.08, mode: "none" as Mode, edge: 0, costBps,
      entryWindow: "dayClose" as const, exitWindow: "all" as const,
    };

    const lastOf = new Map<string, string>();
    for (const sym of uni.symbols) {
      const last = sym.axisIndex[sym.axisIndex.length - 1];
      lastOf.set(sym.ticker, uni.axis[last].slice(0, 10));
    }
    const axisEnd = uni.axis[uni.axis.length - 1].slice(0, 10);
    const stale = [...lastOf].filter(([, d]) => d < W.to).sort((a, b) => a[1].localeCompare(b[1]));

    console.log(`\n=== ${tf} 数据提前断裂的票（轴末 ${axisEnd}，窗口末 ${W.to}）===`);
    for (const [tk, d] of stale) console.log(`  ${tk.padEnd(6)} 止于 ${d}`);
    if (stale.length === 0) {
      console.log("  无");
      return;
    }

    const cfg = { ...base, ...OVER, ...W, timeframe: tf } as BacktestConfig;
    const full = runRotate(uni, cfg, O);
    const bad = new Set(stale.map(([tk]) => tk));
    const uni2 = { ...uni, symbols: uni.symbols.filter((s) => !bad.has(s.ticker)) };
    const cut = runRotate(uni2, cfg, O);

    const legs = full.lotPnl.filter((l) => bad.has(l.symbol));
    console.log(`\n这些票在定档回测里已平仓 ${legs.length} 笔` +
      (legs.length ? `：${legs.map((l) => `${l.symbol} ${l.pct >= 0 ? "+" : ""}${l.pct.toFixed(2)}%`).join("  ")}` : ""));
    console.log(`开仓 ${full.entries} 笔 / 已平 ${full.lotPnl.length} 笔 → 收盘时仍持有 ${full.entries - full.lotPnl.length} 笔`);

    const row = (label: string, r: typeof full) =>
      console.log(
        label.padEnd(16) + `${r.cagr.toFixed(2)}%`.padStart(9) + `${r.dd.toFixed(2)}%`.padStart(9) +
          r.mar.toFixed(3).padStart(8) + String(r.entries).padStart(7) + `${r.avgExposure.toFixed(1)}%`.padStart(9),
      );
    console.log("\n" + "".padEnd(16) + "CAGR".padStart(9) + "回撤".padStart(9) + "MAR".padStart(8) + "开仓".padStart(7) + "敞口".padStart(9));
    row("含这些票", full);
    row("剔除后", cut);
    console.log(`\nMAR 差 ${(full.mar - cut.mar).toFixed(3)}   CAGR 差 ${(full.cagr - cut.cagr).toFixed(2)}pt`);
    console.log(
      `注：定档这组在断裂时并未持有它们（清算逻辑未触发，平仓笔数与修复前一致），` +
        `所以上面的差异是机会成本，不是数据缺陷。`,
    );

    // 断裂清算逻辑本身要能工作：把止损与吊灯放到永不触发，持仓必然活到数据断裂那天。
    const WIDE = { ...OVER, stopMult: 999, trailMult: 999 };
    const wide = runRotate(uni, { ...base, ...WIDE, ...W, timeframe: tf } as BacktestConfig, O);
    const wideLegs = wide.lotPnl.filter((l) => bad.has(l.symbol));
    console.log(`\n--- 清算逻辑验证（止损/吊灯放到 999 倍 ATR，持仓必然撑到断裂日）---`);
    console.log(`  ${[...bad].join("/")} 的平仓记录 ${wideLegs.length} 笔` +
      (wideLegs.length ? `：${wideLegs.map((l) => `${l.symbol} ${l.pct >= 0 ? "+" : ""}${l.pct.toFixed(2)}%`).join("  ")}` : "  ← 若为 0 则清算未生效"));
  }

  if (part === "seed") {
    // 4H 当初的坑：根数看着够，EMA676 却没播种，vegasOk 恒 0，整段被迫空仓。
    // 根数达标不等于指标可用，这里直接查窗口内每根有多少票的 Vegas / RPS / RSI 真的就绪。
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    const loIdx = uni.axis.findIndex((a) => a.slice(0, 10) >= W.from);
    const hiRaw = uni.axis.findIndex((a) => a.slice(0, 10) > W.to);
    const hi = hiRaw < 0 ? uni.axis.length : hiRaw;

    // 每只票在窗口内的本地起始下标
    const startOf = (sym: (typeof uni.symbols)[number]) => {
      for (let k = 0; k < sym.axisIndex.length; k += 1) if (sym.axisIndex[k] >= loIdx) return k;
      return -1;
    };

    let atStart = { data: 0, vegas: 0, rps: 0, rsi: 0 };
    let firstTrueLate = 0;
    const firstTrueDates: string[] = [];
    for (const sym of uni.symbols) {
      const i = startOf(sym);
      if (i < 0) continue;
      atStart.data += 1;
      if (sym.vegasOk[i] === 1) atStart.vegas += 1;
      if (sym.rps[i] >= 1) atStart.rps += 1;
      if (sym.rsi14[i] > 0) atStart.rsi += 1;
      // 窗口内第一次 vegasOk=1 的日期：大面积集中在窗口开始很久之后 = 预热不足的指纹
      let ft = "";
      for (let k = i; k < sym.axisIndex.length && sym.axisIndex[k] < hi; k += 1) {
        if (sym.vegasOk[k] === 1) { ft = uni.axis[sym.axisIndex[k]].slice(0, 10); break; }
      }
      if (ft) {
        firstTrueDates.push(ft);
        if (ft > "2021-12-31") firstTrueLate += 1;
      }
    }

    // 全窗口逐根：有多少票 Vegas 站上
    let sum = 0;
    let bars = 0;
    for (let g = loIdx; g < hi; g += 1) bars += 1;
    const perBar: number[] = new Array(bars).fill(0);
    for (const sym of uni.symbols) {
      for (let k = 0; k < sym.axisIndex.length; k += 1) {
        const g = sym.axisIndex[k];
        if (g < loIdx || g >= hi) continue;
        if (sym.vegasOk[k] === 1) { perBar[g - loIdx] += 1; sum += 1; }
      }
    }
    const q = (xs: number[], p: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * p))];
    };
    const sortedFt = [...firstTrueDates].sort();

    console.log(`\n=== ${tf} 预热与播种审计 ===`);
    console.log(`池内 ${uni.symbols.length} 只   窗口 ${W.from} → ${W.to}   ${bars} 根`);
    console.log(`\n窗口第一根（${uni.axis[loIdx]}）上的就绪情况：`);
    console.log(`  有数据 ${atStart.data} 只   Vegas 站上 ${atStart.vegas} 只（${((atStart.vegas / atStart.data) * 100).toFixed(0)}%）   ` +
      `RPS 已排名 ${atStart.rps} 只（${((atStart.rps / atStart.data) * 100).toFixed(0)}%）   RSI 就绪 ${atStart.rsi} 只`);
    console.log(`\n窗口内每根「Vegas 站上」票数：均值 ${(sum / bars).toFixed(1)}   ` +
      `中位 ${q(perBar, 0.5)}   最小 ${Math.min(...perBar)}   最大 ${Math.max(...perBar)}`);
    console.log(`  前 20 根均值 ${(perBar.slice(0, 20).reduce((a, b) => a + b, 0) / 20).toFixed(1)}   ` +
      `后 20 根均值 ${(perBar.slice(-20).reduce((a, b) => a + b, 0) / 20).toFixed(1)}`);
    console.log(`\n各票窗口内首次 Vegas 站上的日期：中位 ${sortedFt[Math.floor(sortedFt.length / 2)] ?? "—"}   ` +
      `最早 ${sortedFt[0] ?? "—"}   晚于 2021 年底的 ${firstTrueLate} 只`);
    if (atStart.vegas === 0) console.log(`\n  ⚠ 窗口第一根无任何票站上 Vegas —— 与 4H 当初的未播种症状一致`);
  }

  if (part === "hold") {
    // 四周期定档（grid2 定前 6 维 + best3 定后 4 维）下的成交与持仓画像。
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    const FINAL: Record<string, { over: Record<string, unknown>; o: Opts; label: string }> = {
      "4h": {
        over: { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 0, requireRsi: true, minRsi: 30, rpsExit: null },
        o: { slotPct: 0.08, mode: "none", edge: 0, costBps, entryWindow: "dayClose", exitWindow: "all" },
        label: "止8 吊10 无盈 门0 8% 入收盘 RSI≥30 出场关",
      },
      "2h": {
        over: { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 30, requireRsi: false, rpsExit: 10 },
        o: { slotPct: 0.125, mode: "none", edge: 0, costBps, entryWindow: "dayClose", exitWindow: "all" },
        label: "止8 吊10 无盈 门30 12.5% 入收盘 RSI关 出场10",
      },
      // 四个级别里只有 1H 的最优解要开置换——置换在这里不是增益，是给一个本来就在亏的
      // 策略止血：它把三段最差从 -0.32 拉到 -0.00，代价是 CAGR 从 15.6% 掉到 9.2%。
      "1h": {
        over: { stopMult: 6, trailMult: 8, takeProfitR: 3, rpsMin: 30, requireRsi: true, minRsi: 50, rpsExit: 30 },
        o: { slotPct: 0.125, mode: "weakest", edge: 0, costBps, entryWindow: "all", exitWindow: "dayClose" },
        label: "止6 吊8 盈3R 门30 12.5% 入每根 RSI≥50 出场30 置换+0 平收盘",
      },
      "1d": {
        over: { stopMult: 4, trailMult: 8, takeProfitR: 3, rpsMin: 10, requireRsi: false, rpsExit: 10 },
        o: { slotPct: 0.125, mode: "none", edge: 0, costBps, entryWindow: "dayClose", exitWindow: "all" },
        label: "止4 吊8 盈3R 门10 12.5% 入收盘 RSI关 出场10",
      },
    };
    const f = FINAL[tf];
    const r = runRotate(uni, { ...base, ...f.over, ...W, timeframe: tf } as BacktestConfig, f.o);

    const q = (xs: number[], p: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(s.length * p))];
    };
    const pcts = r.lotPnl.map((l) => l.pct);
    const wins = pcts.filter((p) => p > 0);
    const losses = pcts.filter((p) => p <= 0);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const slots = Math.floor(1 / f.o.slotPct);
    // curve 每根一个点，4H 一天两根。折算持仓天数必须用去重后的真实交易日数
    const days = new Set(r.curve.map((c) => c.date.slice(0, 10))).size;
    // Little's Law：平均在手数 = 平仓速率 × 平均持仓时长，反解出时长
    const holdDays = r.lotPnl.length ? (r.avgHoldings * days) / r.lotPnl.length : 0;
    // lotPnl.pct 是「对组合权益的贡献率」，不是标的涨跌幅。按单笔仓位折回标的口径供对照
    const toSym = (p: number) => p / f.o.slotPct;

    console.log(`\n=== ${tf} 定档画像（${f.label}，成本 ${costBps}bps）===`);
    console.log(`区间 ${W.from} → ${W.to}   ${days} 个交易日 / ${r.holdCounts.length} 根`);
    console.log(`CAGR ${r.cagr.toFixed(1)}%   回撤 ${r.dd.toFixed(0)}%   MAR ${r.mar.toFixed(2)}`);

    console.log(`\n【成交】`);
    console.log(`  开仓 ${r.entries} 笔   平仓 ${r.lotPnl.length} 笔   年均成交 ${r.tradesPerYear.toFixed(0)} 笔（含开平）`);
    console.log(`  满仓错过信号 ${r.missed} 次   放弃率 ${((r.missed / (r.missed + r.entries)) * 100).toFixed(0)}%`);
    console.log(`  胜率 ${((wins.length / pcts.length) * 100).toFixed(1)}%（${wins.length}/${pcts.length}）`);
    console.log(`  平均持仓 ${holdDays.toFixed(0)} 个交易日（Little's Law 反解）`);
    console.log(`\n  下列百分比均为「对组合权益的贡献」，括号内为按每笔 ${(f.o.slotPct * 100).toFixed(1)}% 折回的标的涨跌幅：`);
    console.log(`  平均盈利 +${avg(wins).toFixed(2)}%权益（标的 +${toSym(avg(wins)).toFixed(0)}%）   ` +
      `平均亏损 ${avg(losses).toFixed(2)}%权益（标的 ${toSym(avg(losses)).toFixed(0)}%）   盈亏比 ${(avg(wins) / Math.abs(avg(losses))).toFixed(2)}`);
    console.log(`  单笔期望 ${avg(pcts) >= 0 ? "+" : ""}${avg(pcts).toFixed(2)}%权益   ` +
      `最大盈 +${Math.max(...pcts).toFixed(1)}%权益（标的 +${toSym(Math.max(...pcts)).toFixed(0)}%）   ` +
      `最大亏 ${Math.min(...pcts).toFixed(1)}%权益（标的 ${toSym(Math.min(...pcts)).toFixed(0)}%）`);
    console.log(`  单笔分位（%权益） P10 ${q(pcts, 0.1).toFixed(2)}  P25 ${q(pcts, 0.25).toFixed(2)}  ` +
      `中位 ${q(pcts, 0.5).toFixed(2)}  P75 ${q(pcts, 0.75).toFixed(2)}  P90 ${q(pcts, 0.9).toFixed(2)}`);
    const sorted = [...pcts].sort((a, b) => b - a);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const share = (k: number) => (grossWin > 0 ? (sorted.slice(0, k).reduce((a, b) => a + b, 0) / grossWin) * 100 : 0);
    console.log(`  毛利集中度：前 5 笔占 ${share(5).toFixed(0)}%   前 10 笔占 ${share(10).toFixed(0)}%   净贡献合计 ${pcts.reduce((a, b) => a + b, 0).toFixed(0)}%权益`);

    const hc = r.holdCounts;
    console.log(`\n【持仓只数】槽位上限 ${slots} 个（每笔 ${(f.o.slotPct * 100).toFixed(1)}%）`);
    console.log(`  中位数 ${q(hc, 0.5)}   均值 ${r.avgHoldings.toFixed(1)}   最大 ${Math.max(...hc)}`);
    console.log(`  P10 ${q(hc, 0.1)}   P25 ${q(hc, 0.25)}   P75 ${q(hc, 0.75)}   P90 ${q(hc, 0.9)}`);
    console.log(`  空仓 ${((hc.filter((c) => c === 0).length / hc.length) * 100).toFixed(1)}%   ` +
      `满槽 ${((hc.filter((c) => c >= slots).length / hc.length) * 100).toFixed(1)}%   ` +
      `平均敞口 ${r.avgExposure.toFixed(0)}%`);
    const histMax = Math.max(...hc);
    console.log(`  分布：`);
    for (let c = 0; c <= histMax; c += 1) {
      const n = hc.filter((x) => x === c).length;
      if (n === 0) continue;
      const pct = (n / hc.length) * 100;
      console.log(`    ${String(c).padStart(2)} 只  ${pct.toFixed(1).padStart(5)}%  ${"█".repeat(Math.round(pct / 2))}`);
    }
  }

  if (part === "nb") {
    // 576 组的第一名要么在平台上，要么是尖峰。逐维单变量扫邻域，看三段最差会不会塌。
    // 网格只测了 4/5/6/8 和 5/6/8/10，这里把中间值 7/9/12/14 也补上。
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    const BASE_OVER = { stopMult: 8, trailMult: 10, takeProfitR: null as number | null, rpsMin: 0 };
    const BASE_O: Opts = {
      slotPct: 0.08, mode: "none" as Mode, edge: 0, costBps,
      entryWindow: "dayClose" as const, exitWindow: "all" as const,
    };
    const evalOne = (over: Record<string, unknown>, o: Opts) => {
      const f = runRotate(uni, { ...base, ...over, ...W, timeframe: tf } as BacktestConfig, o);
      const m3 = worst([0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o)));
      const tr = runRotate(uni, { ...base, ...over, ...TR, timeframe: tf } as BacktestConfig, o);
      const os = runRotate(uni, { ...base, ...over, ...OOS, timeframe: tf } as BacktestConfig, o);
      return { cagr: f.cagr, dd: f.dd, mar: f.mar, m3: m3.mar, tr: tr.mar, os: os.mar };
    };
    const head =
      "变动".padEnd(24) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
      "三段最差".padStart(10) + "训练".padStart(8) + "样本外".padStart(9);
    const row = (label: string, r: ReturnType<typeof evalOne>) =>
      console.log(
        label.padEnd(24) + `${r.cagr.toFixed(1)}%`.padStart(8) + `${r.dd.toFixed(0)}%`.padStart(7) +
          r.mar.toFixed(2).padStart(7) + r.m3.toFixed(2).padStart(10) +
          r.tr.toFixed(2).padStart(8) + r.os.toFixed(2).padStart(9),
      );

    console.log(`\n=== ${tf} 候选邻域：止8 吊10 无盈 门0 8% 收盘入（成本 ${costBps}bps）===`);
    console.log(head);
    row("★ 候选本身", evalOne(BASE_OVER, BASE_O));

    console.log("\n--- 止损倍数 ---");
    for (const v of [5, 6, 7, 8, 9, 10, 12]) row(`止损 ${v}`, evalOne({ ...BASE_OVER, stopMult: v }, BASE_O));

    console.log("\n--- 吊灯倍数 ---");
    for (const v of [6, 8, 9, 10, 12, 14]) row(`吊灯 ${v}`, evalOne({ ...BASE_OVER, trailMult: v }, BASE_O));

    console.log("\n--- RPS 门槛 ---");
    for (const v of [0, 5, 10, 20, 30]) row(`门槛 ${v}`, evalOne({ ...BASE_OVER, rpsMin: v }, BASE_O));

    console.log("\n--- 止盈 ---");
    for (const v of [null, 2, 3, 4] as (number | null)[])
      row(`止盈 ${v ?? "无"}`, evalOne({ ...BASE_OVER, takeProfitR: v }, BASE_O));

    console.log("\n--- 每笔比例 ---");
    for (const v of [0.06, 0.08, 0.1, 0.125, 0.15])
      row(`每笔 ${(v * 100).toFixed(1)}%`, evalOne(BASE_OVER, { ...BASE_O, slotPct: v }));

    console.log("\n--- 执行窗口 ---");
    for (const ew of ["all", "dayClose"] as const)
      for (const xw of ["all", "dayClose"] as const)
        row(
          `入${ew === "all" ? "每根" : "收盘"}/出${xw === "all" ? "每根" : "收盘"}`,
          evalOne(BASE_OVER, { ...BASE_O, entryWindow: ew, exitWindow: xw }),
        );

    console.log("\n--- 置换 ---");
    for (const e of [0, 10, 20, 30])
      row(`置换 +${e}`, evalOne(BASE_OVER, { ...BASE_O, mode: "weakest" as Mode, edge: e }));

    console.log("\n--- 旧冻结档对照 ---");
    row(
      "止5 吊6 门10 10%",
      evalOne({ stopMult: 5, trailMult: 6, takeProfitR: null, rpsMin: 10 }, { ...BASE_O, slotPct: 0.1 }),
    );
  }

  if (part === "conc") {
    // 业绩里有多少是「这个池子恰好装了几只神股」。剔票必须真重跑：坑位会让给别的票，
    // 从收益里直接减是高估影响。随机剔同样只数作对照，否则分不清「剔掉神股」和
    // 「池子变小」两个效应。RPS 用标普外部标尺，剔票不会让门槛漂移。
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    const OVER = { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 0 };
    const O: Opts = {
      slotPct: 0.08, mode: "none" as Mode, edge: 0, costBps,
      entryWindow: "dayClose" as const, exitWindow: "all" as const,
    };
    const cfg = { ...base, ...OVER, ...W, timeframe: tf } as BacktestConfig;
    const full = runRotate(uni, cfg, O);

    const bySym = new Map<string, { net: number; n: number; win: number }>();
    for (const l of full.lotPnl) {
      const e = bySym.get(l.symbol) ?? { net: 0, n: 0, win: 0 };
      e.net += l.pct;
      e.n += 1;
      if (l.pct > 0) e.win += 1;
      bySym.set(l.symbol, e);
    }
    const ranked = [...bySym].sort((a, b) => b[1].net - a[1].net);
    const totalNet = ranked.reduce((a, b) => a + b[1].net, 0);

    console.log(`\n=== ${tf} 票级集中度（止8 吊10 门0 8% 收盘入，成本 ${costBps}bps）===`);
    console.log(
      `全池：CAGR ${full.cagr.toFixed(1)}%  回撤 ${full.dd.toFixed(0)}%  MAR ${full.mar.toFixed(2)}  ` +
        `已平仓 ${full.lotPnl.length} 笔  涉及 ${bySym.size} 只票  净贡献合计 ${totalNet.toFixed(0)}% 权益`,
    );

    console.log("\n--- 贡献最大的 12 只 ---");
    console.log("票".padEnd(8) + "净贡献%".padStart(10) + "占总净".padStart(9) + "笔数".padStart(6) + "胜率".padStart(7));
    for (const [s, e] of ranked.slice(0, 12))
      console.log(
        s.padEnd(8) + e.net.toFixed(1).padStart(10) +
          `${((e.net / totalNet) * 100).toFixed(1)}%`.padStart(9) +
          String(e.n).padStart(6) + `${((e.win / e.n) * 100).toFixed(0)}%`.padStart(7),
      );
    const cum = (k: number) => (ranked.slice(0, k).reduce((a, b) => a + b[1].net, 0) / totalNet) * 100;
    console.log(
      `\n累计占净贡献：前1只 ${cum(1).toFixed(0)}%  前3只 ${cum(3).toFixed(0)}%  ` +
        `前5只 ${cum(5).toFixed(0)}%  前10只 ${cum(10).toFixed(0)}%  前20只 ${cum(20).toFixed(0)}%`,
    );
    const neg = ranked.filter(([, e]) => e.net < 0);
    console.log(
      `净亏损的票：${neg.length}/${bySym.size} 只，合计 ${neg.reduce((a, b) => a + b[1].net, 0).toFixed(0)}% 权益`,
    );

    const drop = (names: Set<string>) =>
      runRotate({ ...uni, symbols: uni.symbols.filter((s) => !names.has(s.ticker)) }, cfg, O);
    const allNames = uni.symbols.map((s) => s.ticker);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

    console.log("\n--- 剔除贡献最大的 N 只 vs 随机剔 N 只（随机 15 次取中位）---");
    console.log(
      "N".padStart(3) + "剔最强 CAGR/回撤/MAR".padStart(26) + "随机中位 CAGR/回撤/MAR".padStart(28) + "   被剔的票",
    );
    for (const N of [1, 3, 5, 10, 20]) {
      const topNames = new Set(ranked.slice(0, N).map(([s]) => s));
      const t = drop(topNames);
      const rc: number[] = [], rd: number[] = [], rm: number[] = [];
      for (let k = 0; k < 15; k += 1) {
        // 线性同余，让随机对照可复现
        let seed = k * 7919 + N;
        const pick = new Set<string>();
        while (pick.size < N) {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          pick.add(allNames[seed % allNames.length]);
        }
        const r = drop(pick);
        rc.push(r.cagr); rd.push(r.dd); rm.push(r.mar);
      }
      console.log(
        String(N).padStart(3) +
          `${t.cagr.toFixed(1)}%/${t.dd.toFixed(0)}%/${t.mar.toFixed(2)}`.padStart(26) +
          `${median(rc).toFixed(1)}%/${median(rd).toFixed(0)}%/${median(rm).toFixed(2)}`.padStart(28) +
          "   " + ranked.slice(0, Math.min(N, 6)).map(([s]) => s).join(" ") + (N > 6 ? " …" : ""),
      );
    }

    // 公平对照：收益分布天生右偏，剔掉事后头部对任何东西都是毁灭性的。所以要看
    // 池内买入持有在**同等操作**（剔掉自己涨幅前 N）下掉多少，才知道这是策略的
    // 缺陷还是池子的属性。
    const { lo, hi } = windowBounds(uni.axis, cfg);
    const years = (hi - lo) / barsPerYearOf(tf);
    const bhMul = new Map<string, number>();
    const bhCurve = new Map<string, Float64Array>();
    for (const sym of uni.symbols) {
      let first = -1;
      let last = -1;
      for (let i = 0; i < sym.axisIndex.length; i += 1) {
        const d = sym.axisIndex[i];
        if (d < lo || d >= hi) continue;
        if (sym.isMember[i] !== 1 || !(sym.close[i] > 0)) continue;
        if (first < 0) first = i;
        last = i;
      }
      // 只算窗口起点就在册的票，和图上「池内买入持有」同一口径
      if (first < 0 || last <= first || sym.axisIndex[first] > lo + 5) continue;
      bhMul.set(sym.ticker, sym.close[last] / sym.close[first]);
      const c = new Float64Array(hi - lo).fill(NaN);
      for (let i = first; i <= last; i += 1) {
        const d = sym.axisIndex[i];
        if (d < lo || d >= hi) continue;
        c[d - lo] = sym.close[i] / sym.close[first];
      }
      bhCurve.set(sym.ticker, c);
    }
    const bhStats = (exclude: Set<string>) => {
      const names = [...bhMul.keys()].filter((t) => !exclude.has(t));
      const eq = new Float64Array(hi - lo);
      const last = new Map<string, number>();
      for (let k = 0; k < hi - lo; k += 1) {
        let s = 0;
        for (const t of names) {
          const v = bhCurve.get(t)![k];
          if (!Number.isNaN(v)) last.set(t, v);
          s += last.get(t) ?? 1;
        }
        eq[k] = s / names.length;
      }
      let peak = eq[0];
      let dd = 0;
      for (const v of eq) {
        if (v > peak) peak = v;
        dd = Math.max(dd, (peak - v) / peak);
      }
      const cagr = (Math.pow(eq[eq.length - 1] / eq[0], 1 / years) - 1) * 100;
      return { cagr, dd: dd * 100, mar: dd > 0 ? cagr / (dd * 100) : 0 };
    };
    const bhRanked = [...bhMul].sort((a, b) => b[1] - a[1]);
    const bhFull = bhStats(new Set());

    console.log(
      `\n--- 对照：池内买入持有剔掉自己涨幅前 N（${bhMul.size} 只窗口起点在册）---`,
    );
    console.log(
      "N".padStart(3) + "策略剔贡献前N".padStart(18) + "降幅".padStart(8) +
        "买持剔涨幅前N".padStart(18) + "降幅".padStart(8) + "   买持被剔的票",
    );
    console.log(
      "  0" + `${full.cagr.toFixed(1)}%`.padStart(18) + "-".padStart(8) +
        `${bhFull.cagr.toFixed(1)}%`.padStart(18) + "-".padStart(8),
    );
    for (const N of [1, 3, 5, 10, 20]) {
      const s = drop(new Set(ranked.slice(0, N).map(([t]) => t)));
      const b = bhStats(new Set(bhRanked.slice(0, N).map(([t]) => t)));
      console.log(
        String(N).padStart(3) +
          `${s.cagr.toFixed(1)}%`.padStart(18) +
          `${(((s.cagr - full.cagr) / full.cagr) * 100).toFixed(0)}%`.padStart(8) +
          `${b.cagr.toFixed(1)}%`.padStart(18) +
          `${(((b.cagr - bhFull.cagr) / bhFull.cagr) * 100).toFixed(0)}%`.padStart(8) +
          "   " + bhRanked.slice(0, Math.min(N, 5)).map(([t]) => t).join(" ") + (N > 5 ? " …" : ""),
      );
    }

    // 最直接的判据：剔掉**同一批**头部票后，策略相对买入持有的超额还剩多少。
    // 超额随 N 消失 = 价值只在头部票上；超额稳定 = 纪律在全池普遍有效。
    console.log("\n--- 剔掉同一批票（买持涨幅前 N），策略 vs 买入持有 ---");
    console.log(
      "剔除".padStart(4) + "策略 CAGR/回撤/MAR".padStart(24) + "买持 CAGR/回撤/MAR".padStart(24) +
        "超额".padStart(8) + "MAR 倍数".padStart(10),
    );
    for (const N of [0, 3, 10, 20, 40]) {
      const names = new Set(bhRanked.slice(0, N).map(([t]) => t));
      const s = N === 0 ? full : drop(names);
      const b = bhStats(names);
      console.log(
        `${N}`.padStart(4) +
          `${s.cagr.toFixed(1)}%/${s.dd.toFixed(0)}%/${s.mar.toFixed(2)}`.padStart(24) +
          `${b.cagr.toFixed(1)}%/${b.dd.toFixed(0)}%/${b.mar.toFixed(2)}`.padStart(24) +
          `${(s.cagr - b.cagr).toFixed(1)}pt`.padStart(8) +
          `${b.mar > 0 ? (s.mar / b.mar).toFixed(2) : "-"}x`.padStart(10),
      );
    }
  }

  if (part === "recheck") {
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    const W = { from: SEGMENTS[2].from, to: SEGMENTS[2].to };
    const dailyO: Opts = {
      slotPct: 0.125, mode: "weakest" as Mode, edge: 20, costBps,
      entryWindow: "all" as const, exitWindow: "all" as const,
    };
    const fourO: Opts = {
      slotPct: 0.1, mode: "none" as Mode, edge: 0, costBps,
      entryWindow: "dayClose" as const, exitWindow: "all" as const,
    };
    const VARIANTS =
      tf === "1d"
        ? [{ label: "日线冻结档 门40/止4/吊5.5/12.5%+置换20", over: { rpsMin: 40, stopMult: 4, trailMult: 5.5 }, o: dailyO }]
        : [
            { label: "4H 冻结档 门10/止5/吊6/每笔10% 收盘入·即时出", over: { rpsMin: 10, stopMult: 5, trailMult: 6 }, o: fourO },
            { label: "  变体：每根入场", over: { rpsMin: 10, stopMult: 5, trailMult: 6 }, o: { ...fourO, entryWindow: "all" as const } },
            { label: "  变体：每笔 8%", over: { rpsMin: 10, stopMult: 5, trailMult: 6 }, o: { ...fourO, slotPct: 0.08 } },
            { label: "  变体：门槛 30", over: { rpsMin: 30, stopMult: 5, trailMult: 6 }, o: fourO },
          ];
    console.log(`\n=== ${tf} 补数据后重算（日频口径，成本 ${costBps}bps）===`);
    for (const v of VARIANTS) {
      const f = runRotate(uni, { ...base, ...v.over, ...W, timeframe: tf } as BacktestConfig, v.o);
      const segs = [0, 1, 2].map((i) => runRotate(uni, cfg3(i, v.over), v.o));
      const m3 = worst(segs);
      const tr = runRotate(uni, { ...base, ...v.over, ...TR, timeframe: tf } as BacktestConfig, v.o);
      const os = runRotate(uni, { ...base, ...v.over, ...OOS, timeframe: tf } as BacktestConfig, v.o);
      console.log(`\n${v.label}`);
      console.log(
        `  全期5年     ${f.cagr.toFixed(1)}% / 回撤 ${f.dd.toFixed(1)}% / MAR ${f.mar.toFixed(2)}` +
          `   开仓 ${f.entries} 笔   敞口 ${f.avgExposure.toFixed(0)}%   持仓均 ${f.avgHoldings.toFixed(1)} 只`,
      );
      console.log(`  三段最差    MAR ${m3.mar.toFixed(2)}`);
      segs.forEach((sg, i) =>
        console.log(
          `    ${SEG3[i].label} ${SEG3[i].from}→${SEG3[i].to}   ` +
            `${sg.cagr.toFixed(1)}% / ${sg.dd.toFixed(1)}% / ${sg.mar.toFixed(2)}`,
        ),
      );
      console.log(`  训练前3年   ${tr.cagr.toFixed(1)}% / ${tr.dd.toFixed(1)}% / ${tr.mar.toFixed(2)}`);
      console.log(`  样本外后2年 ${os.cagr.toFixed(1)}% / ${os.dd.toFixed(1)}% / ${os.mar.toFixed(2)}`);
    }
  }

  if (part === "audit") {
    const TFS: Timeframe[] = ["1d", "4h", "2h", "1h"];
    const W = { from: "2021-08-24", to: "2026-08-24" };
    // 四个周期用同一组参数，这样差异只来自周期口径本身，不来自调参
    const OVER = { rpsMin: 10, stopMult: 5, trailMult: 6, takeProfitR: null };
    const O: Opts = {
      slotPct: 0.1, mode: "none" as Mode, edge: 0, costBps: 10,
      entryWindow: "all" as const, exitWindow: "all" as const,
    };

    type A = {
      tf: string; bars: number; tdays: number; perDay: number; dist: string;
      constBpy: number; measBpy: number; devPct: number;
      first: string; last: string; warmBars: number; vegasDays: number; atrDays: number;
      barCagr: number; barDd: number; barMar: number;
      dayCagr: number; dayDd: number; dayMar: number; dayPts: number;
    };
    const rows: A[] = [];
    const rpsProbe: string[] = [];

    for (const t of TFS) {
      const u = await getPreparedUniverse("SMALLFUND", t);
      const cfg = { ...baseOf(t), ...OVER, ...W, timeframe: t } as BacktestConfig;
      const { lo, hi } = windowBounds(u.axis, cfg);
      const win = u.axis.slice(lo, hi);
      const days = new Map<string, number>();
      for (const a of win) days.set(a.slice(0, 10), (days.get(a.slice(0, 10)) ?? 0) + 1);
      const dist = new Map<number, number>();
      for (const c of days.values()) dist.set(c, (dist.get(c) ?? 0) + 1);
      const perDay = win.length / days.size;
      const measBpy = perDay * 252;
      const constBpy = barsPerYearOf(t);

      const f = runRotate(u, cfg, O);
      // 日频压缩：每个自然日取最后一根的净值，再按 252 重算
      const byDay = new Map<string, number>();
      for (const pt of f.curve) byDay.set(pt.date.slice(0, 10), pt.v);
      const dEq = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
      const ds = statsOf(dEq, 252);

      rows.push({
        tf: t, bars: win.length, tdays: days.size, perDay,
        dist: [...dist.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}根×${v}天`).join(" "),
        constBpy, measBpy, devPct: ((constBpy / measBpy) - 1) * 100,
        first: win[0] ?? "-", last: win[win.length - 1] ?? "-",
        warmBars: lo, vegasDays: 676 / perDay, atrDays: 14 / perDay,
        barCagr: f.cagr, barDd: f.dd, barMar: f.mar,
        dayCagr: ds.cagr, dayDd: ds.dd, dayMar: ds.mar, dayPts: dEq.length,
      });

      // RPS 抽查：同一票同一天，各周期应当拿到完全相同的日线 RPS
      const sym = u.symbols.find((x) => x.ticker === "NVDA");
      if (sym) {
        const want = "2023-06-15";
        const vals: number[] = [];
        for (let k = 0; k < sym.axisIndex.length; k += 1) {
          if (u.axis[sym.axisIndex[k]].slice(0, 10) === want) vals.push(sym.rps[k]);
        }
        rpsProbe.push(`${t}: NVDA ${want} rps = [${vals.map((v) => v.toFixed(2)).join(", ")}]`);
      }
    }

    console.log("\n=== A. 年化基数：常量 vs 实测（窗口 2021-08→2026-08）===");
    console.log(
      "周期".padEnd(6) + "窗口根数".padStart(10) + "交易日".padStart(8) + "根/天".padStart(8) +
        "常量bpy".padStart(9) + "实测bpy".padStart(9) + "偏差".padStart(8) + "  每天根数分布",
    );
    for (const r of rows)
      console.log(
        r.tf.padEnd(6) + String(r.bars).padStart(10) + String(r.tdays).padStart(8) +
          r.perDay.toFixed(3).padStart(8) + String(r.constBpy).padStart(9) +
          r.measBpy.toFixed(0).padStart(9) + `${r.devPct >= 0 ? "+" : ""}${r.devPct.toFixed(1)}%`.padStart(8) +
          "  " + r.dist,
      );

    console.log("\n=== B. 回撤采样频率：bar 级 vs 日频压缩（同一条净值曲线）===");
    console.log(
      "周期".padEnd(6) + "bar级CAGR".padStart(11) + "bar级回撤".padStart(11) + "bar级MAR".padStart(10) +
        "  |" + "日频CAGR".padStart(10) + "日频回撤".padStart(10) + "日频MAR".padStart(9) +
        "回撤差".padStart(9) + "MAR差".padStart(8),
    );
    for (const r of rows)
      console.log(
        r.tf.padEnd(6) + `${r.barCagr.toFixed(1)}%`.padStart(11) + `${r.barDd.toFixed(1)}%`.padStart(11) +
          r.barMar.toFixed(2).padStart(10) + "  |" + `${r.dayCagr.toFixed(1)}%`.padStart(10) +
          `${r.dayDd.toFixed(1)}%`.padStart(10) + r.dayMar.toFixed(2).padStart(9) +
          `${(r.barDd - r.dayDd).toFixed(1)}pt`.padStart(9) + `${(r.dayMar - r.barMar).toFixed(2)}`.padStart(8),
      );

    console.log("\n=== C. 指标的日历跨度（根数固定 ⇒ 跨度随周期变）===");
    console.log(
      "周期".padEnd(6) + "Vegas慢线676根".padStart(16) + "ATR14".padStart(12) +
        "预热根数".padStart(10) + "窗口首根".padStart(24) + "窗口末根".padStart(24),
    );
    for (const r of rows)
      console.log(
        r.tf.padEnd(6) + `${r.vegasDays.toFixed(0)}交易日`.padStart(16) +
          `${r.atrDays.toFixed(1)}交易日`.padStart(12) + String(r.warmBars).padStart(10) +
          r.first.padStart(24) + r.last.padStart(24),
      );

    console.log("\n=== D. RPS 跨周期一致性抽查 ===");
    rpsProbe.forEach((l) => console.log("  " + l));
  }

  if (part === "audit2") {
    const TFS: Timeframe[] = ["1d", "4h", "2h", "1h"];
    const W = { from: "2021-08-24", to: "2026-08-24" };
    const OVER = { rpsMin: 10, stopMult: 5, trailMult: 6, takeProfitR: null };
    const O: Opts = {
      slotPct: 0.1, mode: "none" as Mode, edge: 0, costBps: 10,
      entryWindow: "all" as const, exitWindow: "all" as const,
    };
    for (const t of TFS) {
      const u = await getPreparedUniverse("SMALLFUND", t);
      const cfg = { ...baseOf(t), ...OVER, ...W, timeframe: t } as BacktestConfig;
      const { lo, hi } = windowBounds(u.axis, cfg);
      console.log(`\n=== ${t}：数据起点 ${u.axis[0]}，窗口起点第 ${lo} 根，Vegas 慢线需 676 根 ===`);

      // 每根：全池有多少票 vegasOk=1 / 多少票是成分
      const pass = new Float64Array(u.axis.length);
      const memb = new Float64Array(u.axis.length);
      for (const sym of u.symbols) {
        for (let k = 0; k < sym.axisIndex.length; k += 1) {
          const g = sym.axisIndex[k];
          if (sym.isMember[k] === 1) {
            memb[g] += 1;
            if (sym.vegasOk[k] === 1) pass[g] += 1;
          }
        }
      }
      const f = runRotate(u, cfg, O);
      // 按月汇总：Vegas 通过率 + 该月持仓均值
      const mon = new Map<string, { p: number; m: number; n: number; h: number; hn: number }>();
      for (let g = lo; g < hi; g += 1) {
        const k = u.axis[g].slice(0, 7);
        const e = mon.get(k) ?? { p: 0, m: 0, n: 0, h: 0, hn: 0 };
        e.p += pass[g]; e.m += memb[g]; e.n += 1;
        mon.set(k, e);
      }
      for (let i = 0; i < f.holdCounts.length; i += 1) {
        const k = u.axis[lo + i]?.slice(0, 7);
        const e = k ? mon.get(k) : undefined;
        if (e) { e.h += f.holdCounts[i]; e.hn += 1; }
      }
      const keys = [...mon.keys()].sort();
      const line = keys
        .slice(0, 24)
        .map((k) => {
          const e = mon.get(k)!;
          const rate = e.m > 0 ? (e.p / e.m) * 100 : 0;
          const h = e.hn > 0 ? e.h / e.hn : 0;
          return `${k} ${rate.toFixed(0)}%/${h.toFixed(1)}`;
        })
        .join("  ");
      console.log("  前24个月 [Vegas通过率/持仓只数]：");
      console.log("  " + line);
      const firstHold = f.holdCounts.findIndex((c) => c > 0);
      console.log(
        `  首次持仓：第 ${firstHold} 根 = ${firstHold >= 0 ? u.axis[lo + firstHold] : "从未"}` +
          `（距窗口起点 ${firstHold >= 0 ? ((firstHold / (t === "1d" ? 1 : t === "4h" ? 2 : t === "2h" ? 3.52 : 6)) / 21).toFixed(1) : "-"} 个月）`,
      );
    }
  }

  if (part === "best") {
    // 该周期的真实天花板：全期 + 三段 + 训练/样本外
    const OOS = { from: "2024-08-25", to: "2026-08-24" };
    const TR = { from: "2021-08-24", to: "2024-08-24" };
    type Row = {
      label: string; cagr: number; dd: number; mar: number; m3: number;
      bear: number; bearCagr: number; tr: number; oos: number; entries: number;
    };
    const out: Row[] = [];
    for (const stopMult of [5, 6, 8])
      for (const trailMult of [8, 10, 12])
        for (const takeProfitR of [null, 4])
          for (const rpsMin of [0, 10, 30])
            for (const slotPct of [0.08, 0.1])
              for (const ew of ["all", "dayClose"] as const) {
                const over = { stopMult, trailMult, takeProfitR, rpsMin };
                const o: Opts = {
                  slotPct, mode: "none" as Mode, edge: 0, costBps,
                  entryWindow: ew, exitWindow: "all" as const,
                };
                const f = runRotate(
                  uni,
                  { ...base, ...over, from: SEGMENTS[2].from, to: SEGMENTS[2].to, timeframe: tf } as BacktestConfig,
                  o,
                );
                const segs = [0, 1, 2].map((i) => runRotate(uni, cfg3(i, over), o));
                const m3 = worst(segs);
                const trr = runRotate(uni, { ...base, ...over, ...TR, timeframe: tf } as BacktestConfig, o);
                const os = runRotate(uni, { ...base, ...over, ...OOS, timeframe: tf } as BacktestConfig, o);
                out.push({
                  label: `止${stopMult} 吊${trailMult} ${takeProfitR ? `盈${takeProfitR}R` : "无盈"} 门${rpsMin} ${(slotPct * 100).toFixed(0)}% 入${ew === "all" ? "每根" : "收盘"}`,
                  cagr: f.cagr, dd: f.dd, mar: f.mar, m3: m3.mar,
                  bear: segs[0].mar, bearCagr: segs[0].cagr, tr: trr.mar, oos: os.mar, entries: f.entries,
                });
              }
    const head =
      "配置".padEnd(36) + "CAGR".padStart(8) + "回撤".padStart(7) + "MAR".padStart(7) +
      "三段最差".padStart(10) + "熊市段".padStart(14) + "样本外".padStart(8) + "开仓".padStart(7);
    const pr = (r: Row) =>
      console.log(
        r.label.padEnd(36) + `${r.cagr.toFixed(1)}%`.padStart(8) + `${r.dd.toFixed(0)}%`.padStart(7) +
          r.mar.toFixed(2).padStart(7) + r.m3.toFixed(2).padStart(10) +
          `${r.bearCagr.toFixed(0)}%/${r.bear.toFixed(2)}`.padStart(14) +
          r.oos.toFixed(2).padStart(8) + String(r.entries).padStart(7),
      );
    console.log(`\n=== ${tf} 加密网格 ${out.length} 组 ===`);
    console.log("\n--- 按全期 MAR ---\n" + head);
    [...out].sort((a, b) => b.mar - a.mar).slice(0, 6).forEach(pr);
    console.log("\n--- 按三段最差 ---\n" + head);
    [...out].sort((a, b) => b.m3 - a.m3).slice(0, 6).forEach(pr);
    console.log("\n--- 按 CAGR ---\n" + head);
    [...out].sort((a, b) => b.cagr - a.cagr).slice(0, 4).forEach(pr);
  }

  if (part === "holdings") {
    console.log(`\n=== ${tf} 持仓只数分布（12.5% +20，成本 ${costBps}bps）===`);
    for (let i = 0; i < SEGMENTS.length; i += 1) {
      const r = runRotate(uni, cfgOf(i), { slotPct: 0.125, mode: "weakest", edge: 20, costBps });
      const cs = [...r.holdCounts].sort((a, b) => a - b);
      const n = cs.length;
      const q = (p: number) => cs[Math.floor((n - 1) * p)];
      const dist = new Map<number, number>();
      for (const c of r.holdCounts) dist.set(c, (dist.get(c) ?? 0) + 1);
      const rows = [...dist.entries()].sort((a, b) => a[0] - b[0]);
      const mode = rows.reduce((a, b) => (b[1] > a[1] ? b : a));
      console.log(
        `\n${SEGMENTS[i].label}  共 ${n} 根  均值 ${(r.holdCounts.reduce((a, b) => a + b, 0) / n).toFixed(2)}  ` +
          `中位数 ${q(0.5)}  众数 ${mode[0]}（占 ${((mode[1] / n) * 100).toFixed(0)}%）  ` +
          `25分位 ${q(0.25)}  75分位 ${q(0.75)}  最大 ${cs[n - 1]}`,
      );
      console.log("  只数  根数   占比   累计");
      let cum = 0;
      for (const [k, v] of rows) {
        cum += v / n;
        const bar = "█".repeat(Math.round((v / n) * 60));
        console.log(
          `  ${String(k).padStart(3)}  ${String(v).padStart(5)}  ${((v / n) * 100).toFixed(1).padStart(5)}%  ` +
            `${(cum * 100).toFixed(0).padStart(4)}%  ${bar}`,
        );
      }
    }
  }

  if (part === "robust") {
    console.log(`\n=== ${tf} 收益集中度：靠不靠少数几笔撑（12.5% +20，成本 ${costBps}bps）===`);
    for (let i = 0; i < SEGMENTS.length; i += 1) {
      const r = runRotate(uni, cfgOf(i), {
        slotPct: 0.125,
        mode: "weakest",
        edge: 20,
        costBps,
      });
      const wins = r.lotPnl.filter((l) => l.pct > 0);
      const losses = r.lotPnl.filter((l) => l.pct <= 0);
      const sum = (xs: { pct: number }[]) => xs.reduce((a, b) => a + b.pct, 0);
      const top = [...wins].sort((a, b) => b.pct - a.pct);
      const grossWin = sum(wins);
      const net = sum(r.lotPnl);
      const share = (n: number) =>
        grossWin > 0 ? ((sum(top.slice(0, n)) / grossWin) * 100).toFixed(0) : "0";
      console.log(
        `\n${SEGMENTS[i].label}  已平仓 ${r.lotPnl.length} 笔  胜率 ${((wins.length / Math.max(1, r.lotPnl.length)) * 100).toFixed(0)}%  ` +
          `毛盈 ${grossWin.toFixed(0)}%  毛亏 ${sum(losses).toFixed(0)}%  净 ${net.toFixed(0)}%`,
      );
      console.log(
        `  最大 1 笔占毛盈 ${share(1)}%   前 3 笔 ${share(3)}%   前 5 笔 ${share(5)}%   前 10 笔 ${share(10)}%`,
      );
      console.log(
        `  最赚的 5 笔：` +
          top.slice(0, 5).map((l) => `${l.symbol} +${l.pct.toFixed(1)}%`).join("  "),
      );
      const worstLots = [...losses].sort((a, b) => a.pct - b.pct).slice(0, 5);
      console.log(
        `  最亏的 5 笔：` + worstLots.map((l) => `${l.symbol} ${l.pct.toFixed(1)}%`).join("  "),
      );
    }
  }

  if (part === "detail") {
    console.log(`\n=== ${tf} 重点配置逐段明细（成本 ${costBps}bps）===`);
    const picks: { label: string; slotPct: number; mode: Mode; edge: number }[] = [
      { label: "12.5% 不置换", slotPct: 0.125, mode: "none", edge: 0 },
      { label: "12.5% +20", slotPct: 0.125, mode: "weakest", edge: 20 },
      { label: "10% +15", slotPct: 0.1, mode: "weakest", edge: 15 },
      { label: "15% +25", slotPct: 0.15, mode: "weakest", edge: 25 },
      { label: "20% +20", slotPct: 0.2, mode: "weakest", edge: 20 },
    ];
    for (const p of picks) {
      console.log(`\n${p.label}`);
      for (let i = 0; i < SEGMENTS.length; i += 1) {
        const r = runRotate(uni, cfgOf(i), { ...p, costBps });
        console.log(
          `  ${SEGMENTS[i].label}  CAGR ${r.cagr.toFixed(1)}%  回撤 ${r.dd.toFixed(0)}%  ` +
            `MAR ${r.mar.toFixed(2)}  开仓 ${r.entries}  置换 ${r.rotations}  放弃 ${r.missed}  ` +
            `均持仓 ${r.avgHoldings.toFixed(1)}  敞口 ${r.avgExposure.toFixed(0)}%  ` +
            `年均 ${r.tradesPerYear.toFixed(0)} 笔`,
        );
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
