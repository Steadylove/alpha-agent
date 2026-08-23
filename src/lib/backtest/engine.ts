/**
 * 调参回测引擎。
 *
 * 刻意分成两段，缓存边界在中间：
 *   - `prepareUniverse` 只依赖行情与成分资格，算信号与截面 RPS。全池一次几秒，
 *     参数变化时不重算。
 *   - `runBacktest` 只吃参数，跑交易层与组合层，可支撑滑块交互。
 *
 * 数据按列存：全池 296 万根日线若按 `{date,high,low,close}` 存成对象是三百万个
 * JS 对象，光对象头就几百 MB。这里日期轴全局存一份，每只标的只存 Int32 下标
 * 与 Float32 价格，整池约 70MB。
 *
 * 三条硬规矩，都是为了防止结果自欺：
 *   1. **时点成分**：某日只在当日的指数成分中选股，截面 RPS 也只在当日成分间排名。
 *   2. **同池基准**：每个结果都同时给出「同一时点池等权买入持有」的对照。
 *      单看策略收益没有意义——这个池子本身在 20 年里涨了很多。
 *   3. **样本内外分离**：统计按 `splitDate` 切开分别输出，调参只该看训练区。
 */

import { computeLogMacdSeries } from "@/lib/scoring/logMacd";
import { PERCENTILE_RS_TERMS } from "@/lib/scoring/percentileRs";
import {
  computeRotationTrades,
  type ClosedTrade,
  type ExitReason,
  type TradeBar,
} from "@/lib/scoring/rotationTrade";

import type { PanelBars } from "./panel";

const TRADING_DAYS_PER_YEAR = 252;

export type MembershipSpan = { start: string; end: string | null };

export type PreparedSymbol = {
  ticker: string;
  /** 每根 K 线在全局日期轴中的下标，升序 */
  axisIndex: Int32Array;
  high: Float32Array;
  low: Float32Array;
  close: Float32Array;
  buy1: Uint8Array;
  buy2: Uint8Array;
  /** 截面分位，仅当日成分参与排名；非成分日为 0 */
  rps: Float32Array;
  isMember: Uint8Array;
};

export type PreparedUniverse = {
  /** 全局日期轴，升序 */
  axis: string[];
  symbols: PreparedSymbol[];
};

/**
 * 截面分位，语义与 `percentileRs.percentileRank` 一致（below + equal/2 的中位排名法）。
 *
 * 不复用那个实现是因为它是 O(n²)：本引擎要在 5000 个交易日上各排 500 只，
 * O(n²) 是十亿级操作。这里改用排序实现，降到 O(n log n)。
 */
export function percentileRanksFast(scores: ArrayLike<number>): Float64Array {
  const n = scores.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (n === 1) {
    out[0] = 50;
    return out;
  }

  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a] - scores[b]);

  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]] === scores[idx[i]]) j += 1;

    const below = i;
    const equal = j - i + 1;
    const pct = Math.min(99, Math.max(1, ((below + equal / 2) / n) * 100));
    for (let k = i; k <= j; k += 1) out[idx[k]] = pct;
    i = j + 1;
  }
  return out;
}

/**
 * 4Q-Alpha 原始超额分。
 *
 * 与 `percentileRs.alphaScoreAt` 的区别是标的与基准各用自己的下标：那个函数
 * 要求调用方先把两条序列按日期对齐，`percentileRsBySymbol` 却没有对齐就调用
 * （已算出基准下标 bi 但传了标的下标），这里避开该前提。
 */
function alphaScore(
  closes: ArrayLike<number>,
  at: number,
  bench: ArrayLike<number>,
  benchAt: number,
): number {
  let total = 0;
  for (const { lookback, weight } of PERCENTILE_RS_TERMS) {
    const base = closes[at - lookback];
    const benchBase = bench[benchAt - lookback];
    const perf = base == null || base === 0 ? 1 : closes[at] / base;
    const benchPerf = benchBase == null || benchBase === 0 ? 1 : bench[benchAt] / benchBase;
    total += weight * (benchPerf === 0 ? 100 : (perf / benchPerf) * 100);
  }
  return total;
}

const inSpan = (date: string, spans: readonly MembershipSpan[]) =>
  spans.some((s) => date >= s.start && (s.end == null || date <= s.end));

export function prepareUniverse(
  panels: readonly PanelBars[],
  benchmark: PanelBars,
  membership: ReadonlyMap<string, readonly MembershipSpan[]>,
): PreparedUniverse {
  const axis = [...new Set(panels.flatMap((p) => p.dates))].sort();
  const axisPos = new Map(axis.map((d, i) => [d, i]));

  /** 全局轴下标 -> 基准序列的本地下标；-1 表示基准当日无数据 */
  const benchAt = new Int32Array(axis.length).fill(-1);
  benchmark.dates.forEach((d, i) => {
    const pos = axisPos.get(d);
    if (pos != null) benchAt[pos] = i;
  });

  const symbols: PreparedSymbol[] = panels.map((panel) => {
    const n = panel.dates.length;

    // computeLogMacdSeries 要对象数组，用完即弃，不进常驻内存
    const bars: TradeBar[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      bars[i] = {
        date: panel.dates[i],
        high: panel.high[i],
        low: panel.low[i],
        close: panel.close[i],
      };
    }
    const macd = computeLogMacdSeries(bars);
    const spans = membership.get(panel.ticker) ?? [];

    const axisIndex = new Int32Array(n);
    const buy1 = new Uint8Array(n);
    const buy2 = new Uint8Array(n);
    const isMember = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      axisIndex[i] = axisPos.get(panel.dates[i])!;
      buy1[i] = macd[i].buy1 ? 1 : 0;
      buy2[i] = macd[i].buy2 ? 1 : 0;
      isMember[i] = inSpan(panel.dates[i], spans) ? 1 : 0;
    }

    return {
      ticker: panel.ticker,
      axisIndex,
      high: panel.high,
      low: panel.low,
      close: panel.close,
      buy1,
      buy2,
      rps: new Float32Array(n),
      isMember,
    };
  });

  // 逐日截面排名。各标的的 axisIndex 已升序，用游标同步推进即可，
  // 无需为每个日期建 Map。
  const cursor = new Int32Array(symbols.length);
  const scores = new Float64Array(symbols.length);
  const slotSym = new Int32Array(symbols.length);
  const slotLocal = new Int32Array(symbols.length);

  for (let d = 0; d < axis.length; d += 1) {
    const bi = benchAt[d];
    let m = 0;

    for (let s = 0; s < symbols.length; s += 1) {
      const sym = symbols[s];
      const c = cursor[s];
      if (c >= sym.axisIndex.length || sym.axisIndex[c] !== d) continue;
      cursor[s] = c + 1;

      if (bi < 0 || sym.isMember[c] === 0) continue;
      slotSym[m] = s;
      slotLocal[m] = c;
      scores[m] = alphaScore(sym.close, c, benchmark.close, bi);
      m += 1;
    }

    if (m === 0) continue;
    const ranks = percentileRanksFast(scores.subarray(0, m));
    for (let k = 0; k < m; k += 1) {
      symbols[slotSym[k]].rps[slotLocal[k]] = ranks[k];
    }
  }

  return { axis, symbols };
}

export type BacktestConfig = {
  from: string;
  to: string;
  /** 该日（含）之后为保留区，之前为训练区 */
  splitDate: string;
  /** 截面 RPS 门槛，信号只在 RPS >= 此值时采纳 */
  rpsMin: number;
  /**
   * RS 转弱离场：持仓期间截面 RPS 跌破该值即清仓。null 表示不启用（原策略行为）。
   *
   * 非成分日不触发本条：离开指数当日 RPS 会掉到 0，若一并处理，这个参数就同时
   * 在测「转弱离场」和「剔除出指数就卖」，两件事混在一起没法归因。
   */
  rpsExit: number | null;
  stopMult: number;
  trailMult: number;
  takeProfitR: number | null;
  useBuy1: boolean;
  useBuy2: boolean;
};

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  /**
   * 面板起点是 20 年前，但 RS 的 252 日回看与 MACD 的 EMA 需要预热，
   * 首年信号不可用。若把窗口起点设在面板起点，策略会在首年空仓而基准满仓，
   * 白送十几个点的相对收益。这里留足一年预热。
   */
  from: "2007-09-01",
  to: "2026-12-31",
  /**
   * 固定为 2021-08-23（约五年前），不随当前日期滚动：默认值要能复现文档里的数字，
   * 滚动切分点会让同一组参数在不同日期跑出不同结论。
   */
  splitDate: "2021-08-23",

  /**
   * 以下六项不是 Pine 原值，而是 `npm run lab:search` 在 1200 组网格上
   * 筛出、再逐参数细扫定下的一组，详见 docs/spec-conformance.md 第六节。
   *
   * Pine 原值为 RPS 不筛、止损 4.0、吊灯 5.5、不止盈、一买二买都开，
   * 那组在同池基准下是负超额。改默认值是为了让页面打开即是当前最好的已知配置，
   * 代价是它**不是**一个中立起点——保留区的数字已被选参过程污染。
   */
  rpsMin: 30,
  rpsExit: null,
  stopMult: 3.5,
  trailMult: 2.5,
  takeProfitR: 2.5,
  useBuy1: true,
  useBuy2: false,
};

export type TradeStats = {
  trades: number;
  winRatePct: number;
  meanPnlPct: number;
  medianPnlPct: number;
  profitFactor: number;
  avgBarsHeld: number;
  worstPnlPct: number;
  /** 每笔 pnlPct / riskPct 的均值 */
  meanR: number;
  exits: Record<ExitReason, number>;
};

export type PortfolioStats = {
  equity: number;
  cagrPct: number;
  maxDrawdownPct: number;
  volPct: number;
  /** 有持仓的交易日占比 */
  investedDayPct: number;
  days: number;
};

export type WindowResult = {
  label: string;
  from: string;
  to: string;
  trade: TradeStats;
  portfolio: PortfolioStats;
  /** 同一时点池等权买入持有 */
  benchmark: PortfolioStats;
};

export type YearRow = {
  year: number;
  trades: number;
  strategyPct: number;
  benchmarkPct: number;
  isOutOfSample: boolean;
};

export type EquityPoint = { date: string; strategy: number; benchmark: number };

export type BacktestResult = {
  inSample: WindowResult;
  outOfSample: WindowResult;
  byYear: YearRow[];
  equity: EquityPoint[];
  universeSize: number;
  signalCount: number;
};

function tradeStats(trades: readonly ClosedTrade[]): TradeStats {
  const exits: Record<ExitReason, number> = { stop: 0, target: 0, veto: 0, rsWeak: 0 };
  for (const t of trades) exits[t.exitReason] += 1;

  if (trades.length === 0) {
    return {
      trades: 0,
      winRatePct: 0,
      meanPnlPct: 0,
      medianPnlPct: 0,
      profitFactor: 0,
      avgBarsHeld: 0,
      worstPnlPct: 0,
      meanR: 0,
      exits,
    };
  }

  const pnls = trades.map((t) => t.pnlPct);
  const sorted = [...pnls].sort((a, b) => a - b);
  const wins = pnls.filter((p) => p > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p <= 0).reduce((a, b) => a + b, 0));

  return {
    trades: trades.length,
    winRatePct: (wins.length / pnls.length) * 100,
    meanPnlPct: pnls.reduce((a, b) => a + b, 0) / pnls.length,
    medianPnlPct: sorted[Math.floor(sorted.length / 2)],
    profitFactor: grossLoss === 0 ? Infinity : grossWin / grossLoss,
    avgBarsHeld: trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length,
    worstPnlPct: sorted[0],
    meanR:
      trades.reduce((a, t) => a + (t.riskPct > 0 ? t.pnlPct / t.riskPct : 0), 0) / trades.length,
    exits,
  };
}

function portfolioStats(returns: Float64Array): PortfolioStats {
  const n = returns.length;
  if (n === 0) {
    return { equity: 1, cagrPct: 0, maxDrawdownPct: 0, volPct: 0, investedDayPct: 0, days: 0 };
  }

  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let sum = 0;
  let invested = 0;
  for (let i = 0; i < n; i += 1) {
    equity *= 1 + returns[i];
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
    sum += returns[i];
    if (returns[i] !== 0) invested += 1;
  }

  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i += 1) sq += (returns[i] - mean) ** 2;
  const variance = n > 1 ? sq / (n - 1) : 0;
  const years = n / TRADING_DAYS_PER_YEAR;

  return {
    equity,
    cagrPct: years > 0 ? (equity ** (1 / years) - 1) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    volPct: Math.sqrt(variance * TRADING_DAYS_PER_YEAR) * 100,
    investedDayPct: (invested / n) * 100,
    days: n,
  };
}

/** 等权：当日所有持仓标的收益取算术平均，无持仓则当日收益为 0（空仓不计息）。 */
function equalWeight(sum: Float64Array, count: Int32Array): Float64Array {
  const out = new Float64Array(sum.length);
  for (let i = 0; i < sum.length; i += 1) out[i] = count[i] > 0 ? sum[i] / count[i] : 0;
  return out;
}

export function runBacktest(universe: PreparedUniverse, config: BacktestConfig): BacktestResult {
  const { axis, symbols } = universe;

  let lo = 0;
  while (lo < axis.length && axis[lo] < config.from) lo += 1;
  let hi = axis.length;
  while (hi > lo && axis[hi - 1] > config.to) hi -= 1;
  const win = axis.slice(lo, hi);
  const w = win.length;

  const heldSum = new Float64Array(w);
  const heldCount = new Int32Array(w);
  const benchSum = new Float64Array(w);
  const benchCount = new Int32Array(w);

  const allTrades: ClosedTrade[] = [];
  let signalCount = 0;
  let activeSymbols = 0;

  for (const sym of symbols) {
    const n = sym.axisIndex.length;
    if (n === 0 || sym.axisIndex[n - 1] < lo || sym.axisIndex[0] >= hi) continue;
    activeSymbols += 1;

    const bars: TradeBar[] = new Array(n);
    const buy1 = new Array<boolean>(n);
    const buy2 = new Array<boolean>(n);
    const rs = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      bars[i] = {
        date: axis[sym.axisIndex[i]],
        high: sym.high[i],
        low: sym.low[i],
        close: sym.close[i],
      };

      // 信号掩码：窗口内 + 当日为成分 + 截面 RPS 达标 + 该信号类型启用
      const d = sym.axisIndex[i];
      const eligible = d >= lo && d < hi && sym.isMember[i] === 1 && sym.rps[i] >= config.rpsMin;
      buy1[i] = eligible && config.useBuy1 && sym.buy1[i] === 1;
      buy2[i] = eligible && config.useBuy2 && sym.buy2[i] === 1;
      if (buy1[i] || buy2[i]) signalCount += 1;

      // 非成分日填 100：见 BacktestConfig.rpsExit 的注释
      rs[i] = sym.isMember[i] === 1 ? sym.rps[i] : 100;
    }

    // 入场闸门已由上面的 RPS 掩码承担，故 minRs 置 0；rs 只用于转弱离场
    const { days, closed } = computeRotationTrades(sym.ticker, bars, buy1, buy2, rs, {
      minRs: 0,
      useCommercialRsGate: false,
      useEarlyBreakeven: false,
      takeProfitR: config.takeProfitR,
      stopMult: config.stopMult,
      trailMult: config.trailMult,
      rsExitBelow: config.rpsExit,
    });
    allTrades.push(...closed);

    // 组合层用前一根的持仓状态缩放当日收益：开仓价即当根收盘价，
    // 当根的涨跌吃不到，用同根状态会凭空多吃一天。
    for (let i = 1; i < n; i += 1) {
      const d = sym.axisIndex[i] - lo;
      if (d < 0 || d >= w) continue;

      const prev = sym.close[i - 1];
      if (!(prev > 0)) continue;
      const ret = sym.close[i] / prev - 1;
      if (!Number.isFinite(ret)) continue;

      if (sym.isMember[i - 1] === 1) {
        benchSum[d] += ret;
        benchCount[d] += 1;
      }
      if (days[i - 1].sigType !== 0) {
        heldSum[d] += ret;
        heldCount[d] += 1;
      }
    }
  }

  const heldRet = equalWeight(heldSum, heldCount);
  const benchRet = equalWeight(benchSum, benchCount);

  let cut = 0;
  while (cut < w && win[cut] < config.splitDate) cut += 1;

  const buildWindow = (label: string, a: number, b: number): WindowResult => {
    const from = win[a] ?? config.from;
    const to = win[b - 1] ?? config.to;
    return {
      label,
      from,
      to,
      trade: tradeStats(allTrades.filter((t) => t.entryDate >= from && t.entryDate <= to)),
      portfolio: portfolioStats(heldRet.subarray(a, b)),
      benchmark: portfolioStats(benchRet.subarray(a, b)),
    };
  };

  const compound = (rets: Float64Array, a: number, b: number) => {
    let eq = 1;
    for (let i = a; i < b; i += 1) eq *= 1 + rets[i];
    return (eq - 1) * 100;
  };

  const byYear: YearRow[] = [];
  for (let i = 0; i < w; ) {
    const year = win[i].slice(0, 4);
    let j = i;
    while (j < w && win[j].startsWith(year)) j += 1;
    byYear.push({
      year: Number(year),
      trades: allTrades.filter((t) => t.entryDate.startsWith(year)).length,
      strategyPct: compound(heldRet, i, j),
      benchmarkPct: compound(benchRet, i, j),
      isOutOfSample: year >= config.splitDate.slice(0, 4),
    });
    i = j;
  }

  // 净值曲线：全窗口连续复利，前端画图用
  const equity: EquityPoint[] = new Array(w);
  let se = 1;
  let be = 1;
  for (let i = 0; i < w; i += 1) {
    se *= 1 + heldRet[i];
    be *= 1 + benchRet[i];
    equity[i] = { date: win[i], strategy: se, benchmark: be };
  }

  return {
    inSample: buildWindow("训练区", 0, cut),
    outOfSample: buildWindow("保留区", cut, w),
    byYear,
    equity,
    universeSize: activeSymbols,
    signalCount,
  };
}
