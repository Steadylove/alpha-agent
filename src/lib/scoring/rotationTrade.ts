/**
 * 轮动雷达的持仓状态机：开仓点火、吊灯移动止损、保本锁、平仓结算。
 *
 * 对齐「美股动能满仓轮动雷达」Pine 第 119~182 行。
 *
 * Pine 命名提示：源码里的 `tp_level` 名为止盈，实为跟随最高价的吊灯**止损**
 * （初始 = 开仓价 - 5.5×ATR，在开仓价下方），本模块改名 trailLevel 以免误读。
 *
 * 成交时点与 Pine 不同，是有意的：点火与出场条件全部取自收盘价，收盘价要等收盘
 * 之后才存在，所以两者都只能在**次日开盘**成交。Pine（以及本模块此前的实现）按
 * 信号当根收盘价成交，等于在知道收盘价的同时还能拿到它，白吃了隔夜跳空。
 */

import { atrSeries, smaSeries } from "./series";

/**
 * `open` 缺失时成交价退化为当根收盘价。成交时点仍是次日，只是价格精度变差，
 * 不会退回「信号当根收盘成交」那种拿不到的价。
 */
export type TradeBar = {
  date: string;
  high: number;
  low: number;
  close: number;
  open?: number;
};

export type RotationTradeParams = {
  /**
   * RS 低于此值的点火不开仓。设为 0 等同于 Pine 原版（无闸门）。
   *
   * **这一项不在任何一份规格里**，是本项目自加的校准项：轮动 Pine 只有一个
   * 默认关闭的 `RSI > 30` 过滤，与 RS 评分无关。
   */
  minRs: number;
  /**
   * 商业化文档独有：`RS >= 70` 才准入场、`RS < 40` 一票否决。
   * 两份 Pine 都没有这条，默认关闭以保持回测口径不变。
   */
  useCommercialRsGate: boolean;
  /**
   * 商业化文档独有：Path 2 或 5 日下跌概率 >= 60% 时，保本触发从 +10% 提前到 +5%。
   * 两份 Pine 都只有 +10%，默认关闭。
   */
  useEarlyBreakeven: boolean;
  /** 启用提前保本时，逐日提供当日宏观条件；未提供视为不满足。 */
  earlyBreakevenActive?: (index: number) => boolean;
  /**
   * R 倍数止盈：收盘价达到 `开仓价 + takeProfitR × 1R` 时离场。
   * 1R 取开仓时的止损距离（`INITIAL_STOP_MULT × ATR`）。
   *
   * **原策略没有任何止盈**——Pine 里名为 `tp_level` 的变量实为吊灯止损，
   * 位于开仓价下方。故 `null`（默认）复现原版行为，非 null 是新增能力。
   *
   * 注意此改动方向上大概率减少收益：原策略的正期望几乎全部来自右尾
   * （中位 +0.53% vs 均值 +7.24%），截断右尾正是最伤它的做法。
   * 这个参数存在的意义是让这件事可被测量，而不是假定它有好处。
   */
  takeProfitR?: number | null;
  /** 初始止损的 ATR 倍数，同时定义 1R。省略取 Pine 原值 4.0。 */
  stopMult?: number;
  /**
   * 吊灯止损的基准 ATR 倍数。省略取 Pine 原值 5.5。
   *
   * 浮盈分档收紧的两档按比例跟随：原版 25% 档 4.2、50% 档 3.5，
   * 即基准的 76% 与 64%，改基准时保持这两个比例不变。
   */
  trailMult?: number;
  /**
   * RS 转弱离场：持仓期间 RS 跌破该值即按收盘价清仓。null 表示不启用。
   *
   * 与入场端的 `minRs` 是两件事：入场问「现在够不够强」，这个问「还够不够强」。
   * 原策略只有入场闸门，开仓后完全不看 RS。
   */
  rsExitBelow?: number | null;
};

/** 商业化文档第 148~152 行的截面 RS 门槛。 */
export const COMMERCIAL_RS_ENTRY = 70;
export const COMMERCIAL_RS_VETO = 40;

const ATR_LENGTH = 14;
const ATR_SMOOTH = 14;
const INITIAL_STOP_MULT = 4.0;
const INITIAL_TRAIL_MULT = 5.5;
/** 浮盈越高，吊灯收得越紧；ratio 为基准倍数的比例，基准即 `trailMult`。 */
const TRAIL_MULT_TIERS = [
  { minPnl: 50, ratio: 3.5 / INITIAL_TRAIL_MULT },
  { minPnl: 25, ratio: 4.2 / INITIAL_TRAIL_MULT },
  { minPnl: -Infinity, ratio: 1 },
];

/**
 * 交易层回测结论：30 是唯一让胜率、均值、盈亏比三项同时改善的档位
 * （629 笔 52.8%/+7.07%/2.47 → 508 笔 53.7%/+7.24%/2.70）。
 *
 * 注意不要往上加：RS>=45 会砍掉 69% 的成交而均值反降到 +6.32%。
 * 信号层看裸前向收益时低 RS 显得更糟，但 4×ATR 止损已经处理了同一个问题，
 * 闸门与止损是替代关系，叠太狠只是白丢样本。
 */
export const DEFAULT_TRADE_PARAMS: RotationTradeParams = {
  minRs: 30,
  useCommercialRsGate: false,
  useEarlyBreakeven: false,
  takeProfitR: null,
  stopMult: INITIAL_STOP_MULT,
  trailMult: INITIAL_TRAIL_MULT,
  rsExitBelow: null,
};

/** 浮盈达到该百分比后，止损上移到开仓价之上锁定。 */
const BREAKEVEN_TRIGGER_PCT = 10;
/** 商业化文档第 217 行的提前档。 */
const EARLY_BREAKEVEN_TRIGGER_PCT = 5;
const BREAKEVEN_LOCK_RATIO = 1.01;

export type SignalType = 0 | 1 | 2;

/**
 * 触发离场的条件。
 *
 * `veto` 仅在商业化 RS 闸门开启时出现（阈值写死 40）；
 * `rsWeak` 是可调阈值的 RS 转弱离场，两者互不依赖。
 */
export type ExitReason = "stop" | "target" | "veto" | "rsWeak";

export type ClosedTrade = {
  symbol: string;
  sigType: 1 | 2;
  entryIndex: number;
  entryDate: string;
  entryPrice: number;
  exitIndex: number;
  exitDate: string;
  exitPrice: number;
  pnlPct: number;
  barsHeld: number;
  exitReason: ExitReason;
  /** 开仓时的 1R 占开仓价的百分比；`pnlPct / riskPct` 即该笔的 R 倍数。 */
  riskPct: number;
};

export type TradeDay = {
  sigType: SignalType;
  entryPrice: number | null;
  stopLevel: number | null;
  trailLevel: number | null;
  /** 生效止损：Pine 的退出条件 `close < sl or close < trail` 等价于 close < max(两者)。 */
  effectiveStop: number | null;
  /** R 倍数止盈价；未启用止盈时为 null。 */
  targetLevel: number | null;
  maxPnlPct: number;
  floatPnlPct: number;
  breakevenLocked: boolean;
  /**
   * 该笔的初始 1R 占开仓价的百分比，持仓期内恒定（不随保本锁上移而变）。
   * 组合层按它反比定仓，故清仓成交的那根也要给出——那根仍持有到开盘。
   */
  riskPct: number | null;
  /** 成交日而非点火日：点火在前一根收盘，这里是次日开盘真正建仓的那根。 */
  entered: boolean;
  /** 成交日而非触发日。该根开盘已清仓，故同根的 sigType 已是 0。 */
  exited: boolean;
};

export type RotationTradeResult = { days: TradeDay[]; closed: ClosedTrade[] };

const trailMultFor = (maxPnlPct: number, base: number) =>
  TRAIL_MULT_TIERS.find((tier) => maxPnlPct >= tier.minPnl)!.ratio * base;

export function computeRotationTrades(
  symbol: string,
  bars: TradeBar[],
  buy1: boolean[],
  buy2: boolean[],
  rs: number[],
  params: RotationTradeParams = DEFAULT_TRADE_PARAMS,
): RotationTradeResult {
  const atrRisk = smaSeries(
    atrSeries(bars, ATR_LENGTH).map((v) => v ?? 0),
    ATR_SMOOTH,
  );

  const stopMult = params.stopMult ?? INITIAL_STOP_MULT;
  const trailMult = params.trailMult ?? INITIAL_TRAIL_MULT;

  const days: TradeDay[] = [];
  const closed: ClosedTrade[] = [];

  let sigType: SignalType = 0;
  let entryPrice: number | null = null;
  let entryIndex = -1;
  let stopLevel: number | null = null;
  let trailLevel: number | null = null;
  let highWater = 0;
  let maxPnlPct = 0;
  /** 开仓时的止损距离，即 1R。 */
  let initialRisk = 0;
  /** 收盘产生的指令，次日开盘成交。ATR 一并留存：开盘时只知道到前一根的 ATR。 */
  let pendingEntry: SignalType = 0;
  let pendingEntryAtr = 0;
  let pendingExit: ExitReason | null = null;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const atr = atrRisk[i];
    let entered = false;
    let exited = false;
    const breakevenTrigger =
      params.useEarlyBreakeven && (params.earlyBreakevenActive?.(i) ?? false)
        ? EARLY_BREAKEVEN_TRIGGER_PCT
        : BREAKEVEN_TRIGGER_PCT;

    // ── 开盘：执行前一根收盘挂下的指令 ──
    const fill = bar.open ?? bar.close;
    /** 清仓那根的风险敞口在状态清空前留存，组合层还要用它给这半天定权重。 */
    let exitedRiskPct: number | null = null;

    if (pendingExit != null && entryPrice != null) {
      exitedRiskPct = (initialRisk / entryPrice) * 100;
      closed.push({
        symbol,
        sigType: sigType as 1 | 2,
        entryIndex,
        entryDate: bars[entryIndex].date,
        entryPrice,
        exitIndex: i,
        exitDate: bar.date,
        exitPrice: fill,
        pnlPct: ((fill - entryPrice) / entryPrice) * 100,
        barsHeld: i - entryIndex,
        exitReason: pendingExit,
        riskPct: (initialRisk / entryPrice) * 100,
      });
      sigType = 0;
      entryPrice = null;
      entryIndex = -1;
      stopLevel = null;
      trailLevel = null;
      highWater = 0;
      maxPnlPct = 0;
      initialRisk = 0;
      exited = true;
    }
    pendingExit = null;

    // 出场腾出的仓位当根不会被占回：挂单时还在持仓，点火条件就不成立
    if (pendingEntry !== 0) {
      sigType = pendingEntry;
      entryPrice = fill;
      entryIndex = i;
      stopLevel = fill - stopMult * pendingEntryAtr;
      trailLevel = fill - trailMult * pendingEntryAtr;
      initialRisk = stopMult * pendingEntryAtr;
      highWater = fill;
      maxPnlPct = 0;
      entered = true;
      pendingEntry = 0;
    }

    // 持仓管理：Pine 中这一段在开仓当根同样执行
    let targetLevel: number | null = null;
    if (sigType !== 0 && entryPrice != null && atr != null) {
      highWater = Math.max(highWater, bar.high);
      maxPnlPct = Math.max(maxPnlPct, ((bar.close - entryPrice) / entryPrice) * 100);

      trailLevel = Math.max(trailLevel!, highWater - trailMultFor(maxPnlPct, trailMult) * atr);
      if (maxPnlPct >= breakevenTrigger) {
        stopLevel = Math.max(stopLevel!, entryPrice * BREAKEVEN_LOCK_RATIO);
      }
      targetLevel =
        params.takeProfitR != null && initialRisk > 0
          ? entryPrice + params.takeProfitR * initialRisk
          : null;

      // 商业化文档的一票否决：RS 跌破 40 直接清仓，与止损条件并列
      const vetoed = params.useCommercialRsGate && rs[i] < COMMERCIAL_RS_VETO;
      const rsWeak = params.rsExitBelow != null && rs[i] < params.rsExitBelow;
      const stopHit = bar.close < stopLevel! || bar.close < trailLevel;
      // 止损先判：同一根上二者理论上可同时成立，此时按不利的一侧结算
      const targetHit = targetLevel != null && bar.close >= targetLevel;

      if (vetoed || rsWeak || stopHit || targetHit) {
        pendingExit = vetoed ? "veto" : stopHit ? "stop" : rsWeak ? "rsWeak" : "target";
      }
    }

    // 点火：条件全部取自当根收盘，故成交只能落到次日开盘。
    // 已挂出场单的持仓不再点火，避免同根既清又建。
    const rsGateOk = params.useCommercialRsGate
      ? rs[i] >= COMMERCIAL_RS_ENTRY
      : rs[i] >= params.minRs;
    if (sigType === 0 && pendingExit == null && atr != null && atr > 0 && rsGateOk) {
      const fired: SignalType = buy1[i] ? 1 : buy2[i] ? 2 : 0;
      if (fired !== 0) {
        pendingEntry = fired;
        pendingEntryAtr = atr;
      }
    }

    const floatPnlPct =
      sigType !== 0 && entryPrice != null ? ((bar.close - entryPrice) / entryPrice) * 100 : 0;

    days.push({
      sigType,
      entryPrice,
      stopLevel,
      trailLevel,
      effectiveStop:
        stopLevel != null && trailLevel != null ? Math.max(stopLevel, trailLevel) : null,
      targetLevel,
      maxPnlPct,
      floatPnlPct,
      breakevenLocked: maxPnlPct >= breakevenTrigger,
      riskPct:
        exitedRiskPct ??
        (entryPrice != null && initialRisk > 0 ? (initialRisk / entryPrice) * 100 : null),
      entered,
      exited,
    });
  }

  return { days, closed };
}
