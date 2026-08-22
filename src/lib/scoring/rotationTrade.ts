/**
 * 轮动雷达的持仓状态机：开仓点火、吊灯移动止损、保本锁、平仓结算。
 *
 * 对齐「美股动能满仓轮动雷达」Pine 第 119~182 行。
 *
 * Pine 命名提示：源码里的 `tp_level` 名为止盈，实为跟随最高价的吊灯**止损**
 * （初始 = 开仓价 - 5.5×ATR，在开仓价下方），本模块改名 trailLevel 以免误读。
 */

import { atrSeries, smaSeries } from "./series";

export type TradeBar = { date: string; high: number; low: number; close: number };

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
};

/** 商业化文档第 148~152 行的截面 RS 门槛。 */
export const COMMERCIAL_RS_ENTRY = 70;
export const COMMERCIAL_RS_VETO = 40;

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
};

const ATR_LENGTH = 14;
const ATR_SMOOTH = 14;
const INITIAL_STOP_MULT = 4.0;
const INITIAL_TRAIL_MULT = 5.5;
/** 浮盈越高，吊灯收得越紧。 */
const TRAIL_MULT_TIERS = [
  { minPnl: 50, mult: 3.5 },
  { minPnl: 25, mult: 4.2 },
  { minPnl: -Infinity, mult: 5.5 },
];
/** 浮盈达到该百分比后，止损上移到开仓价之上锁定。 */
const BREAKEVEN_TRIGGER_PCT = 10;
/** 商业化文档第 217 行的提前档。 */
const EARLY_BREAKEVEN_TRIGGER_PCT = 5;
const BREAKEVEN_LOCK_RATIO = 1.01;

export type SignalType = 0 | 1 | 2;

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
};

export type TradeDay = {
  sigType: SignalType;
  entryPrice: number | null;
  stopLevel: number | null;
  trailLevel: number | null;
  /** 生效止损：Pine 的退出条件 `close < sl or close < trail` 等价于 close < max(两者)。 */
  effectiveStop: number | null;
  maxPnlPct: number;
  floatPnlPct: number;
  breakevenLocked: boolean;
  entered: boolean;
  exited: boolean;
};

export type RotationTradeResult = { days: TradeDay[]; closed: ClosedTrade[] };

const trailMultFor = (maxPnlPct: number) =>
  TRAIL_MULT_TIERS.find((tier) => maxPnlPct >= tier.minPnl)!.mult;

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

  const days: TradeDay[] = [];
  const closed: ClosedTrade[] = [];

  let sigType: SignalType = 0;
  let entryPrice: number | null = null;
  let entryIndex = -1;
  let stopLevel: number | null = null;
  let trailLevel: number | null = null;
  let highWater = 0;
  let maxPnlPct = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const atr = atrRisk[i];
    let entered = false;
    let exited = false;
    const breakevenTrigger =
      params.useEarlyBreakeven && (params.earlyBreakevenActive?.(i) ?? false)
        ? EARLY_BREAKEVEN_TRIGGER_PCT
        : BREAKEVEN_TRIGGER_PCT;

    // 开仓：仅在空仓时点火，ATR 未预热完成则跳过（Pine 中 na 会让止损失效）
    const rsGateOk = params.useCommercialRsGate
      ? rs[i] >= COMMERCIAL_RS_ENTRY
      : rs[i] >= params.minRs;
    if (sigType === 0 && atr != null && atr > 0 && rsGateOk) {
      const fired: SignalType = buy1[i] ? 1 : buy2[i] ? 2 : 0;
      if (fired !== 0) {
        sigType = fired;
        entryPrice = bar.close;
        entryIndex = i;
        stopLevel = bar.close - INITIAL_STOP_MULT * atr;
        trailLevel = bar.close - INITIAL_TRAIL_MULT * atr;
        highWater = bar.high;
        maxPnlPct = 0;
        entered = true;
      }
    }

    // 持仓管理：Pine 中这一段在开仓当根同样执行
    if (sigType !== 0 && entryPrice != null && atr != null) {
      highWater = Math.max(highWater, bar.high);
      maxPnlPct = Math.max(maxPnlPct, ((bar.close - entryPrice) / entryPrice) * 100);

      trailLevel = Math.max(trailLevel!, highWater - trailMultFor(maxPnlPct) * atr);
      if (maxPnlPct >= breakevenTrigger) {
        stopLevel = Math.max(stopLevel!, entryPrice * BREAKEVEN_LOCK_RATIO);
      }

      // 商业化文档的一票否决：RS 跌破 40 直接清仓，与止损条件并列
      const vetoed = params.useCommercialRsGate && rs[i] < COMMERCIAL_RS_VETO;
      if (vetoed || bar.close < stopLevel! || bar.close < trailLevel) {
        closed.push({
          symbol,
          sigType: sigType as 1 | 2,
          entryIndex,
          entryDate: bars[entryIndex].date,
          entryPrice,
          exitIndex: i,
          exitDate: bar.date,
          exitPrice: bar.close,
          pnlPct: ((bar.close - entryPrice) / entryPrice) * 100,
          barsHeld: i - entryIndex,
        });
        exited = true;
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
      maxPnlPct,
      floatPnlPct,
      breakevenLocked: maxPnlPct >= breakevenTrigger,
      entered,
      exited,
    });

    if (exited) {
      sigType = 0;
      entryPrice = null;
      entryIndex = -1;
      stopLevel = null;
      trailLevel = null;
      highWater = 0;
      maxPnlPct = 0;
    }
  }

  return { days, closed };
}
