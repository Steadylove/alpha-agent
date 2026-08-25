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

import { computeLogMacdSeries, type LogMacdBar } from "@/lib/scoring/logMacd";
import { PERCENTILE_RS_TERMS } from "@/lib/scoring/percentileRs";
import {
  computeRotationTrades,
  type ClosedTrade,
  type ExitReason,
  type TradeBar,
  type TradeDay,
} from "@/lib/scoring/rotationTrade";
import { emaSeries, rsiSeries } from "@/lib/scoring/series";

import type { PanelBars } from "./panel";

const TRADING_DAYS_PER_YEAR = 252;
const FOUR_HOUR_BARS_PER_YEAR = 504;
const TWO_HOUR_BARS_PER_YEAR = 1008;

export type Timeframe = "1d" | "4h" | "2h";

export function barsPerYearOf(tf: Timeframe = "1d"): number {
  if (tf === "4h") return FOUR_HOUR_BARS_PER_YEAR;
  if (tf === "2h") return TWO_HOUR_BARS_PER_YEAR;
  return TRADING_DAYS_PER_YEAR;
}

export type MembershipSpan = { start: string; end: string | null };

export type PreparedSymbol = {
  ticker: string;
  /** 每根 K 线在全局日期轴中的下标，升序 */
  axisIndex: Int32Array;
  high: Float32Array;
  low: Float32Array;
  close: Float32Array;
  /** 次日开盘成交价的来源。为 null 表示该标的在加 open 列之前回填，成交价退化为收盘价。 */
  open: Float32Array | null;
  buy1: Uint8Array;
  buy2: Uint8Array;
  /** 截面分位，仅当日成分参与排名；非成分日为 0 */
  rps: Float32Array;
  isMember: Uint8Array;
  /**
   * 过去 50 个交易日的日均成交额（美元）。预热不足或该标的没有成交量数据时为 0，
   * 因此闸门开启时会被排除——这是有意的，无量数据不该悄悄放行。
   */
  adtv50: Float32Array;
  /**
   * 收盘价站上 MA200 **或** MA850。
   *
   * 用「或」而非「且」是照抄规格，且这个选择有道理：站上 850 日线却跌破 200 日线，
   * 正是长期牛股回踩中继的形态——恰好是抄底信号想要的场景。两条均线都未预热时为 0。
   */
  aboveTrend: Uint8Array;
  /** 标准 14 日 RSI。预热不足时为 0，闸门开启时会被排除。 */
  rsi14: Float32Array;
  /**
   * Vegas 通道：min(EMA166, EMA169) > max(EMA576, EMA676)。
   * 四条 EMA 任一未播种则为 0——新股满 676 根之前不参与，不是放行。
   */
  vegasOk: Uint8Array;
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
 * 四周期加权的原始强度分，与 `percentileRs.alphaScoreAt` 同一公式，
 * 只是这里吃 `ArrayLike` 以便直接用 Float32Array，避免逐日建数组。
 *
 * 四段回看任一落空即返回 NaN，表示该标的当日不可排名。
 *
 * 为什么落空要返回 NaN 而不是按「走平」计入：那等于断言「这只股票在它上市前
 * 走平」，池内 156 只起始日晚于轴起点的标的（ABBV、ALLE 这类分拆）在入池头
 * 一年会拿到失真的分数。
 *
 * 也不用「按剩余权重归一化」：那样一只刚上市 22 天的标的会拿 21 日动量冒充
 * 四周期复合分，而新上市标的初期常有暴涨，反而会被系统性推高。
 */
function alphaScore(closes: ArrayLike<number>, at: number): number {
  let total = 0;
  for (const { lookback, weight } of PERCENTILE_RS_TERMS) {
    const base = closes[at - lookback];
    if (base == null || base === 0) return NaN;
    total += weight * (closes[at] / base) * 100;
  }
  return total;
}

const inSpan = (date: string, spans: readonly MembershipSpan[]) =>
  spans.some((s) => date >= s.start && (s.end == null || date <= s.end));

/**
 * 滚动均值，窗口不足时填 0。用累加和而非每点重算：850 日窗口 × 5000 根 × 653 只
 * 若逐点求和是万亿级操作。
 */
function rollingMean(values: ArrayLike<number>, window: number): Float32Array<ArrayBuffer> {
  const n = values.length;
  const out = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

const ADTV_WINDOW = 50;
const TREND_FAST = 200;
const TREND_SLOW = 850;
const RSI_LENGTH = 14;

/** Small Fund 规格的 Vegas 通道。周期写死在准备段：改周期要重算，不进 BacktestConfig。 */
export const VEGAS_FAST = [166, 169] as const;
export const VEGAS_SLOW = [576, 676] as const;

export type VegasLens = {
  fast: readonly [number, number];
  slow: readonly [number, number];
};

const DEFAULT_VEGAS: VegasLens = { fast: VEGAS_FAST, slow: VEGAS_SLOW };

const toCloses = (values: Float32Array) => Array.from(values);

function fillOrZero(src: readonly (number | null)[]): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 1) out[i] = src[i] ?? 0;
  return out;
}

function vegasMask(closes: number[], lens: VegasLens): Uint8Array {
  const a = emaSeries(closes, lens.fast[0]);
  const b = emaSeries(closes, lens.fast[1]);
  const c = emaSeries(closes, lens.slow[0]);
  const d = emaSeries(closes, lens.slow[1]);
  const out = new Uint8Array(closes.length);
  for (let i = 0; i < closes.length; i += 1) {
    const fa = a[i];
    const fb = b[i];
    const sa = c[i];
    const sb = d[i];
    if (fa == null || fb == null || sa == null || sb == null) continue;
    if (Math.min(fa, fb) > Math.max(sa, sb)) out[i] = 1;
  }
  return out;
}

export function prepareUniverse(
  panels: readonly PanelBars[],
  membership: ReadonlyMap<string, readonly MembershipSpan[]>,
  vegas: VegasLens = DEFAULT_VEGAS,
): PreparedUniverse {
  const axis = [...new Set(panels.flatMap((p) => p.dates))].sort();
  const axisPos = new Map(axis.map((d, i) => [d, i]));

  const symbols: PreparedSymbol[] = panels.map((panel) => {
    const n = panel.dates.length;

    // computeLogMacdSeries 要对象数组，用完即弃，不进常驻内存
    const bars: LogMacdBar[] = new Array(n);
    for (let i = 0; i < n; i += 1) {
      bars[i] = {
        high: panel.high[i],
        low: panel.low[i],
        close: panel.close[i],
        // open 为 null 时顶背离的实体上沿退化为收盘价，见 LogMacdBar 注释
        open: panel.open?.[i],
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

    // 成交额用收盘价 × 股数。价格是拆股调整后的，股数是原始的，
    // 两者相乘在拆股日附近会有偏差，但对 50 日均值的量级判断无影响。
    let adtv50 = new Float32Array(n);
    if (panel.volume) {
      const dollar = new Float64Array(n);
      for (let i = 0; i < n; i += 1) dollar[i] = panel.close[i] * panel.volume[i];
      adtv50 = rollingMean(dollar, ADTV_WINDOW);
    }

    const maFast = rollingMean(panel.close, TREND_FAST);
    const maSlow = rollingMean(panel.close, TREND_SLOW);
    const aboveTrend = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      const c = panel.close[i];
      aboveTrend[i] =
        (maFast[i] > 0 && c > maFast[i]) || (maSlow[i] > 0 && c > maSlow[i]) ? 1 : 0;
    }

    const closes = toCloses(panel.close);

    return {
      ticker: panel.ticker,
      axisIndex,
      high: panel.high,
      low: panel.low,
      close: panel.close,
      open: panel.open ?? null,
      buy1,
      buy2,
      rps: new Float32Array(n),
      isMember,
      adtv50,
      aboveTrend,
      rsi14: fillOrZero(rsiSeries(closes, RSI_LENGTH)),
      vegasOk: vegasMask(closes, vegas),
    };
  });

  // 逐日截面排名。各标的的 axisIndex 已升序，用游标同步推进即可，
  // 无需为每个日期建 Map。
  const cursor = new Int32Array(symbols.length);
  const scores = new Float64Array(symbols.length);
  const slotSym = new Int32Array(symbols.length);
  const slotLocal = new Int32Array(symbols.length);

  for (let d = 0; d < axis.length; d += 1) {
    let m = 0;

    for (let s = 0; s < symbols.length; s += 1) {
      const sym = symbols[s];
      const c = cursor[s];
      if (c >= sym.axisIndex.length || sym.axisIndex[c] !== d) continue;
      cursor[s] = c + 1;

      if (sym.isMember[c] === 0) continue;

      // 回看未齐的标的不进当日截面：rps 保持 0，入场闸门据此排除
      const score = alphaScore(sym.close, c);
      if (Number.isNaN(score)) continue;

      slotSym[m] = s;
      slotLocal[m] = c;
      scores[m] = score;
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

  /**
   * 单笔风险预算占净值的百分比：仓位 = 该值 ÷ 止损距离占开仓价的百分比，
   * 权重之和封顶 1（不加杠杆），不足的部分记现金、收益为 0。
   * null 表示退回每日等权，即不看止损距离。
   *
   * 出场规格给的是 0.8，但那是**基金级**政策，隐含假设并发持仓多到能铺满资金。
   * 本策略并发持仓不够，取 0.8 会有一半时间在现金里，而基准恒满仓，
   * 于是「风险平价」和「降杠杆」两件事混在一起没法归因。见 spec-conformance.md。
   */
  riskBudgetPct: number | null;

  /**
   * 以下三项对应「全市场流动性初筛」规格的第一阶段，只作用于**入场资格**，
   * 不改变基准——基准始终是完整时点成分池的等权买入持有，
   * 否则基准会跟着策略口径变，超额就不可比了。
   *
   * 规格里还有一条「总市值 >= 20 亿」没实现：面板只存价量，没有历史股本，
   * 而标普成分股极少跌破 20 亿，这条在本池内近乎空转。见 spec-conformance.md。
   */
  /** 50 日日均成交额下限（美元）。0 表示不筛。 */
  minAdtvUsd: number;
  /** 最低收盘价。0 表示不筛。 */
  minPrice: number;
  /** 要求收盘价站上 MA200 或 MA850。 */
  requireTrend: boolean;

  /** 是否启用 RSI 闸门。关掉时 `minRsi` 不参与判定。 */
  requireRsi: boolean;
  /**
   * 标准 14 日 RSI 下限。预热期 rsi14 为 0，闸门开启时自然排除。
   */
  minRsi: number;
  /** Vegas 通道：min(fastA, fastB) > max(slowA, slowB)。 */
  requireVegas: boolean;
  vegasFastA: number;
  vegasFastB: number;
  vegasSlowA: number;
  vegasSlowB: number;

  /**
   * RPS 定权重的幂次：仓位 ∝ (entryRps/100)^k，再按当日持仓归一化到满仓。
   * null 表示等权。k=0 时每只 raw=1，必须与等权逐位相同。
   */
  rpsWeightPower: number | null;
  /**
   * 最多同时持有只数。满员后新信号不成交，已有仓按原出场走，不按 RPS 踢仓。
   * null 表示不限。
   */
  maxHoldings: number | null;
  /**
   * 单票占净值上限。先按 RPS/风险预算分配，和超过 100% 再缩，
   * 然后才把单票压到这个比例，多出来的记现金。null 表示不限。
   */
  maxNameWeight: number | null;
  timeframe: Timeframe;
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
   * 以下六项不是 Pine 原值，而是 `npm run lab:search` 在 1260 组网格上
   * 筛出、再逐参数细扫定下的一组，详见 docs/spec-conformance.md 第六节。
   *
   * Pine 原值为 RPS 不筛、止损 4.0、吊灯 5.5、不止盈、一买二买都开，
   * 那组在同池基准下是负超额。改默认值是为了让页面打开即是当前最好的已知配置，
   * 代价是它**不是**一个中立起点——保留区的数字已被选参过程污染。
   */
  rpsMin: 30,
  rpsExit: null,
  stopMult: 4,
  trailMult: 2,
  /**
   * 不止盈，与 Pine 原策略一致。
   *
   * 曾默认 3R（实际距离 stopMult × 3 × ATR = 12 ATR），1792 笔里只触发 13 次，
   * 关掉后训练区超额 +5.69% → +5.41%、保留区 +3.51% → +3.37%，即这条规则值 0.2 个点。
   * 关掉是为了少一个自由度：出场因此只剩吊灯止损 + 保本锁一条规则。
   *
   * 副作用是 `stopMult` 变得完全惰性——它比吊灯宽故永不触发，此前仅通过定义 1R
   * 影响止盈距离，止盈关掉后连这个通道也没了。参数保留是为了能测，不是因为它在起作用。
   */
  takeProfitR: null,
  useBuy1: true,
  useBuy2: false,

  // 风险定仓默认关闭：见 riskBudgetPct 的注释与 spec-conformance.md 的实测。
  riskBudgetPct: null,

  // 第一阶段初筛默认关闭：先让它可被度量，再决定要不要开。
  minAdtvUsd: 0,
  minPrice: 0,
  requireTrend: false,

  requireRsi: false,
  minRsi: 30,
  requireVegas: false,
  vegasFastA: VEGAS_FAST[0],
  vegasFastB: VEGAS_FAST[1],
  vegasSlowA: VEGAS_SLOW[0],
  vegasSlowB: VEGAS_SLOW[1],
  rpsWeightPower: null,
  maxHoldings: null,
  maxNameWeight: null,
  timeframe: "1d",
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
  /** 平均总敞口占净值的百分比。风险定仓下不再恒为 100%，不足的部分是现金。 */
  avgExposurePct: number;
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
  /** 对外基准涨跌幅（Small Fund=QQQ，其他=SPY）；未叠曲线时为 null */
  spyPct: number | null;
  isOutOfSample: boolean;
};

export type EquityPoint = { date: string; strategy: number; benchmark: number };

/** 收盘仍持有的一只。权重已按当日规则归一（RPS 定权则和为 100）。 */
export type HoldingRow = {
  symbol: string;
  weightPct: number;
  sigType: 1 | 2;
  entryDate: string | null;
  entryPrice: number;
  floatPnlPct: number;
  entryRps: number | null;
};

/** 逐日账本：净值、敞口、当日买卖。持仓明细在 `holdings` 里按日另存。 */
export type DayBook = {
  date: string;
  strategy: number;
  benchmark: number;
  /** 对外基准净值（Small Fund=QQQ，其他=SPY），窗口首日前一交易日 = 1；未叠曲线时为 null */
  spy: number | null;
  nHold: number;
  exposurePct: number;
  buys: string[];
  sells: string[];
};

export type YearToDate = {
  year: number;
  from: string;
  to: string;
  strategyPct: number;
  benchmarkPct: number;
  spyPct: number | null;
  trades: number;
};

export type HoldingDay = {
  date: string;
  rows: HoldingRow[];
};

export type BacktestResult = {
  inSample: WindowResult;
  outOfSample: WindowResult;
  byYear: YearRow[];
  equity: EquityPoint[];
  book: DayBook[];
  holdings: HoldingDay[];
  ytd: YearToDate | null;
  universeSize: number;
  signalCount: number;
  /** 全部平仓交易，按入场日升序 */
  trades: ClosedTrade[];
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

function portfolioStats(
  returns: Float64Array,
  exposure?: Float64Array,
  barsPerYear = TRADING_DAYS_PER_YEAR,
): PortfolioStats {
  const n = returns.length;
  if (n === 0) {
    return {
      equity: 1,
      cagrPct: 0,
      maxDrawdownPct: 0,
      volPct: 0,
      investedDayPct: 0,
      avgExposurePct: 0,
      days: 0,
    };
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
  const years = n / barsPerYear;

  let expSum = 0;
  if (exposure) for (let i = 0; i < n; i += 1) expSum += Math.min(1, exposure[i]);

  return {
    equity,
    cagrPct: years > 0 ? (equity ** (1 / years) - 1) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    volPct: Math.sqrt(variance * barsPerYear) * 100,
    investedDayPct: (invested / n) * 100,
    avgExposurePct: exposure ? (expSum / n) * 100 : 100,
    days: n,
  };
}

/** 4H 日期是 `YYYY-MM-DDTHH:mm`。只跳过停牌数周以上的缺口，长周末（约 92h）仍计收益。 */
const INTRADAY_HALT_HOURS = 24 * 7;

function hoursBetween(prevDate: string, date: string): number {
  const parse = (value: string) =>
    Date.parse(value.includes("T") ? `${value.length === 16 ? `${value}:00` : value}Z` : `${value}T00:00:00Z`);
  return (parse(date) - parse(prevDate)) / 3_600_000;
}

/** 等权：当日所有持仓标的收益取算术平均，无持仓则当日收益为 0（空仓不计息）。 */
function equalWeight(sum: Float64Array, count: Int32Array): Float64Array {
  const out = new Float64Array(sum.length);
  for (let i = 0; i < sum.length; i += 1) out[i] = count[i] > 0 ? sum[i] / count[i] : 0;
  return out;
}

/**
 * 加权组合的日收益。
 *
 * 权重之和超过 1 时按比例缩回，即不加杠杆；缩回保持相对配比不变，
 * 所以满仓日仍是风险平价。不足 1 的部分是现金，收益记 0（不计息）。
 *
 * 等权口径走的是同一条路径：各持仓权重记 1，和恒 ≥ 1，缩回后正好是除以只数。
 *
 * RPS 定权重：仓位 = (RPS/100)^k。和 < 1 是现金，和 > 1 缩回满仓。
 * 弱信号日必须留现金，不再为了「分配」强行满仓归一。
 */
function positionWeight(day: TradeDay, config: BacktestConfig): number {
  if (config.rpsWeightPower != null) {
    const rps = day.entryRps ?? 0;
    return rps >= 1 ? (rps / 100) ** config.rpsWeightPower : 0;
  }
  if (config.riskBudgetPct != null && day.riskPct != null && day.riskPct > 0) {
    return config.riskBudgetPct / day.riskPct;
  }
  return 1;
}

/**
 * 组合层仓位：先按 raw 相对大小分配，和超过 1 缩回，再封单票占净值上限。
 */
export function allocateNameWeights(raw: readonly number[], cap: number | null): number[] {
  const sum = raw.reduce((a, b) => a + b, 0);
  if (sum <= 0) return raw.map(() => 0);
  const denom = Math.max(1, sum);
  return raw.map((r) => {
    const w = r / denom;
    return cap == null ? w : Math.min(w, cap);
  });
}

/** 回测窗口在全局日期轴上的下标区间 `[lo, hi)`。 */
export function windowBounds(axis: string[], config: BacktestConfig) {
  let lo = 0;
  while (lo < axis.length && axis[lo] < config.from) lo += 1;
  let hi = axis.length;
  while (hi > lo && axis[hi - 1] > config.to) hi -= 1;
  return { lo, hi };
}

export type SymbolRun = {
  bars: TradeBar[];
  days: TradeDay[];
  closed: ClosedTrade[];
  signalCount: number;
  buy1: boolean[];
  buy2: boolean[];
};

/**
 * 单只标的的信号掩码与逐日风控推进。
 *
 * 抽出来是为了让图表接口和回测走**同一份**实现：图上画的进出场点、止损线、
 * 吊灯线必须与逐笔表逐行对齐，各写一遍迟早会漂。
 */
export function vegasLensOf(config: BacktestConfig): VegasLens {
  return {
    fast: [config.vegasFastA, config.vegasFastB],
    slow: [config.vegasSlowA, config.vegasSlowB],
  };
}

function isDefaultVegas(config: BacktestConfig): boolean {
  return (
    config.vegasFastA === VEGAS_FAST[0] &&
    config.vegasFastB === VEGAS_FAST[1] &&
    config.vegasSlowA === VEGAS_SLOW[0] &&
    config.vegasSlowB === VEGAS_SLOW[1]
  );
}

export function runSymbol(
  axis: string[],
  sym: PreparedSymbol,
  config: BacktestConfig,
  lo: number,
  hi: number,
): SymbolRun {
  const n = sym.axisIndex.length;
  const bars: TradeBar[] = new Array(n);
  const buy1 = new Array<boolean>(n);
  const buy2 = new Array<boolean>(n);
  const rs = new Array<number>(n);
  let signalCount = 0;

  // 规格周期走准备段缓存；实验室改了周期才当场重算，避免拖滑块时全池重跑 EMA。
  const vegasOk =
    config.requireVegas && !isDefaultVegas(config)
      ? vegasMask(toCloses(sym.close), vegasLensOf(config))
      : sym.vegasOk;

  for (let i = 0; i < n; i += 1) {
    bars[i] = {
      date: axis[sym.axisIndex[i]],
      high: sym.high[i],
      low: sym.low[i],
      close: sym.close[i],
      open: sym.open?.[i],
    };

    // 信号掩码：窗口内 + 当日为成分 + 流动性/趋势初筛 + 截面 RPS 达标 + 该信号类型启用
    const d = sym.axisIndex[i];
    const liquid =
      (config.minAdtvUsd <= 0 || sym.adtv50[i] >= config.minAdtvUsd) &&
      (config.minPrice <= 0 || sym.close[i] >= config.minPrice) &&
      (!config.requireTrend || sym.aboveTrend[i] === 1) &&
      (!config.requireRsi || sym.rsi14[i] >= config.minRsi) &&
      (!config.requireVegas || vegasOk[i] === 1);
    // rps 为 0 表示当日未进入截面（回看未齐），此时不可入场：
    // 分位下界被夹到 1，所以「已排名」等价于 rps >= 1。
    // 不能只写 rps >= rpsMin —— rpsMin 为 0 时会把未排名的也放进来。
    const ranked = sym.rps[i] >= 1;
    const eligible =
      d >= lo &&
      d < hi &&
      sym.isMember[i] === 1 &&
      ranked &&
      liquid &&
      sym.rps[i] >= config.rpsMin;
    buy1[i] = eligible && config.useBuy1 && sym.buy1[i] === 1;
    buy2[i] = eligible && config.useBuy2 && sym.buy2[i] === 1;
    if (buy1[i] || buy2[i]) signalCount += 1;

    // 非成分日、以及回看未齐（rps=0）的日子都填 100：见 BacktestConfig.rpsExit 的注释。
    // 未排名填 0 会让转弱离场在预热期无条件触发，测出来的就不是这个参数了。
    rs[i] = sym.isMember[i] === 1 && sym.rps[i] >= 1 ? sym.rps[i] : 100;
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

  return { bars, days, closed, signalCount, buy1, buy2 };
}

type SymbolPass = {
  ticker: string;
  days: TradeDay[];
  closed: ClosedTrade[];
};

function stripTrade(days: TradeDay[], from: number, to: number) {
  const last = Math.min(to, days.length - 1);
  for (let i = from; i <= last; i += 1) {
    const d = days[i];
    d.entered = false;
    d.exited = false;
    d.sigType = 0;
    d.entryPrice = null;
    d.riskPct = null;
    d.entryRps = null;
    d.entryDate = null;
    d.stopLevel = null;
    d.trailLevel = null;
    d.effectiveStop = null;
    d.targetLevel = null;
    d.floatPnlPct = 0;
  }
}

/**
 * 满员拒新单。同日先腾出当日离场的坑，再按开仓 RPS 从高到低补。
 * 不重跑单票信号：被拒的那一段不会改成另一笔后来的买点。
 */
export function applyMaxHoldings(runs: SymbolPass[], maxN: number): void {
  if (!(maxN > 0)) return;

  type Job = {
    date: string;
    rps: number;
    ticker: string;
    run: SymbolPass;
    entryIndex: number;
    exitIndex: number;
    exitDate: string;
    closed: ClosedTrade | null;
  };

  const jobs: Job[] = [];
  for (const run of runs) {
    for (const trade of run.closed) {
      jobs.push({
        date: trade.entryDate,
        rps: run.days[trade.entryIndex]?.entryRps ?? 0,
        ticker: trade.symbol,
        run,
        entryIndex: trade.entryIndex,
        exitIndex: trade.exitIndex,
        exitDate: trade.exitDate,
        closed: trade,
      });
    }
    const last = run.days[run.days.length - 1];
    if (last && last.sigType !== 0 && last.entryDate) {
      const already = run.closed.some((t) => t.entryDate === last.entryDate);
      if (!already) {
        const entryIndex = run.days.findIndex((d) => d.entered && d.entryDate === last.entryDate);
        jobs.push({
          date: last.entryDate,
          rps: last.entryRps ?? 0,
          ticker: run.ticker,
          run,
          entryIndex: entryIndex >= 0 ? entryIndex : 0,
          exitIndex: run.days.length - 1,
          exitDate: "9999-12-31",
          closed: null,
        });
      }
    }
  }

  jobs.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.rps !== b.rps) return b.rps - a.rps;
    return a.ticker < b.ticker ? -1 : 1;
  });

  const held = new Map<string, string>();
  const rejected: Job[] = [];
  let i = 0;
  while (i < jobs.length) {
    const day = jobs[i].date;
    for (const [ticker, exitDate] of [...held]) {
      if (exitDate <= day) held.delete(ticker);
    }
    while (i < jobs.length && jobs[i].date === day) {
      const job = jobs[i];
      i += 1;
      if (held.size < maxN) {
        held.set(job.ticker, job.exitDate);
      } else {
        rejected.push(job);
      }
    }
  }

  for (const job of rejected) {
    stripTrade(job.run.days, job.entryIndex, job.exitIndex);
    if (job.closed) {
      job.run.closed = job.run.closed.filter((t) => t !== job.closed);
    }
  }
}

export function runBacktest(universe: PreparedUniverse, config: BacktestConfig): BacktestResult {
  const { axis, symbols } = universe;

  const { lo, hi } = windowBounds(axis, config);
  const win = axis.slice(lo, hi);
  const w = win.length;

  const benchSum = new Float64Array(w);
  const benchCount = new Int32Array(w);

  const allTrades: ClosedTrade[] = [];
  let signalCount = 0;
  let activeSymbols = 0;

  type RawHold = {
    symbol: string;
    raw: number;
    ret: number | null;
    sigType: 1 | 2;
    entryDate: string | null;
    entryPrice: number;
    floatPnlPct: number;
    entryRps: number | null;
  };
  const rawHolds: RawHold[][] = Array.from({ length: w }, () => []);
  const dayBuys: string[][] = Array.from({ length: w }, () => []);
  const daySells: string[][] = Array.from({ length: w }, () => []);

  const passes: { sym: (typeof symbols)[number]; run: SymbolPass; hits: number }[] = [];
  for (const sym of symbols) {
    const n = sym.axisIndex.length;
    if (n === 0 || sym.axisIndex[n - 1] < lo || sym.axisIndex[0] >= hi) continue;
    activeSymbols += 1;
    const { days, closed, signalCount: hits } = runSymbol(axis, sym, config, lo, hi);
    passes.push({
      sym,
      hits,
      run: { ticker: sym.ticker, days, closed },
    });
  }
  if (config.maxHoldings != null) {
    applyMaxHoldings(
      passes.map((p) => p.run),
      config.maxHoldings,
    );
  }

  for (const { sym, run, hits } of passes) {
    signalCount += hits;
    allTrades.push(...run.closed);
    const { days } = run;
    const n = sym.axisIndex.length;

    // 组合层的日收益必须和成交时点对齐：建仓与清仓都发生在开盘，
    // 所以首日只吃到 open→close，末日只吃到 prevClose→open，中间才是收盘到收盘。
    // 基准是买入持有，不涉及成交时点，仍按收盘到收盘计。
    for (let i = 1; i < n; i += 1) {
      const d = sym.axisIndex[i] - lo;
      if (d < 0 || d >= w) continue;

      const prev = sym.close[i - 1];
      if (!(prev > 0)) continue;
      const benchRet = sym.close[i] / prev - 1;
      if (!Number.isFinite(benchRet)) continue;
      // 停牌几个月后的第一根会把整段涨跌记进一根 4H，等权基准会被一只票打飞。
      if (
        config.timeframe !== "1d" &&
        hoursBetween(axis[sym.axisIndex[i - 1]], axis[sym.axisIndex[i]]) > INTRADAY_HALT_HOURS
      ) {
        continue;
      }

      if (sym.isMember[i - 1] === 1) {
        benchSum[d] += benchRet;
        benchCount[d] += 1;
      }

      const day = days[i];
      const open = sym.open?.[i] ?? sym.close[i];
      let ret: number | null = null;
      if (day.entered) ret = open > 0 ? sym.close[i] / open - 1 : null;
      else if (day.exited) ret = open / prev - 1;
      else if (day.sigType !== 0) ret = benchRet;

      if (day.entered) dayBuys[d].push(sym.ticker);
      if (day.exited) daySells[d].push(sym.ticker);
      if (day.sigType !== 0 && day.entryPrice != null) {
        rawHolds[d].push({
          symbol: sym.ticker,
          raw: positionWeight(day, config),
          ret:
            ret != null && Number.isFinite(ret) && day.riskPct != null && day.riskPct > 0
              ? ret
              : null,
          sigType: day.sigType,
          entryDate: day.entryDate,
          entryPrice: day.entryPrice,
          floatPnlPct: day.floatPnlPct,
          entryRps: day.entryRps,
        });
      }
    }
  }

  const heldRet = new Float64Array(w);
  const heldWeight = new Float64Array(w);
  for (let i = 0; i < w; i += 1) {
    const raws = rawHolds[i];
    if (raws.length === 0) continue;
    const ws = allocateNameWeights(
      raws.map((h) => h.raw),
      config.maxNameWeight,
    );
    for (let j = 0; j < raws.length; j += 1) {
      heldWeight[i] += ws[j];
      const ret = raws[j].ret;
      if (ret != null) heldRet[i] += ws[j] * ret;
    }
  }
  const benchRet = equalWeight(benchSum, benchCount);

  let cut = 0;
  while (cut < w && win[cut] < config.splitDate) cut += 1;

  const bpy = barsPerYearOf(config.timeframe);
  const buildWindow = (label: string, a: number, b: number): WindowResult => {
    const from = win[a] ?? config.from;
    const to = win[b - 1] ?? config.to;
    return {
      label,
      from,
      to,
      trade: tradeStats(allTrades.filter((t) => t.entryDate >= from && t.entryDate <= to)),
      portfolio: portfolioStats(heldRet.subarray(a, b), heldWeight.subarray(a, b), bpy),
      benchmark: portfolioStats(benchRet.subarray(a, b), undefined, bpy),
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
      spyPct: null,
      isOutOfSample: year >= config.splitDate.slice(0, 4),
    });
    i = j;
  }

  // 净值曲线：全窗口连续复利，前端画图用
  const equity: EquityPoint[] = new Array(w);
  const book: DayBook[] = new Array(w);
  const holdings: HoldingDay[] = [];
  let se = 1;
  let be = 1;
  for (let i = 0; i < w; i += 1) {
    se *= 1 + heldRet[i];
    be *= 1 + benchRet[i];
    equity[i] = { date: win[i], strategy: se, benchmark: be };

    const raws = rawHolds[i];
    const ws = allocateNameWeights(
      raws.map((h) => h.raw),
      config.maxNameWeight,
    );
    const rows: HoldingRow[] = raws
      .map((h, j) => ({
        symbol: h.symbol,
        weightPct: ws[j] * 100,
        sigType: h.sigType,
        entryDate: h.entryDate,
        entryPrice: h.entryPrice,
        floatPnlPct: h.floatPnlPct,
        entryRps: h.entryRps,
      }))
      .sort((a, b) => b.weightPct - a.weightPct);
    if (rows.length > 0) holdings.push({ date: win[i], rows });

    book[i] = {
      date: win[i],
      strategy: se,
      benchmark: be,
      spy: null,
      nHold: rows.length,
      exposurePct: heldWeight[i] * 100,
      buys: dayBuys[i].sort(),
      sells: daySells[i].sort(),
    };
  }

  const lastDate = win[w - 1];
  const ytdYear = lastDate?.slice(0, 4) ?? "";
  const ytdLo = ytdYear ? win.findIndex((d) => d.startsWith(ytdYear)) : -1;
  const ytd: YearToDate | null =
    ytdLo >= 0
      ? {
          year: Number(ytdYear),
          from: win[ytdLo],
          to: lastDate,
          strategyPct: compound(heldRet, ytdLo, w),
          benchmarkPct: compound(benchRet, ytdLo, w),
          spyPct: null,
          trades: allTrades.filter((t) => t.entryDate.startsWith(ytdYear)).length,
        }
      : null;

  // 逐笔按标的分组产出，明细表要按时间读，这里排一次
  allTrades.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));

  return {
    inSample: buildWindow("训练区", 0, cut),
    outOfSample: buildWindow("保留区", cut, w),
    byYear,
    equity,
    book,
    holdings,
    ytd,
    universeSize: activeSymbols,
    signalCount,
    trades: allTrades,
  };
}
