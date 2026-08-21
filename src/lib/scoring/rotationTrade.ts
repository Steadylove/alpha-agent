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
  /** RS 低于此值的点火不开仓。设为 0 等同于 Pine 原版（无闸门）。 */
  minRs: number;
};

/** 校准结论：RS<30 区间 20/60 日超额均显著为负，45 是兼顾信号量与超额的取值。 */
export const DEFAULT_TRADE_PARAMS: RotationTradeParams = { minRs: 45 };

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

    // 开仓：仅在空仓时点火，ATR 未预热完成则跳过（Pine 中 na 会让止损失效）
    if (sigType === 0 && atr != null && atr > 0 && rs[i] >= params.minRs) {
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
      if (maxPnlPct >= BREAKEVEN_TRIGGER_PCT) {
        stopLevel = Math.max(stopLevel!, entryPrice * BREAKEVEN_LOCK_RATIO);
      }

      if (bar.close < stopLevel! || bar.close < trailLevel) {
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
      breakevenLocked: maxPnlPct >= BREAKEVEN_TRIGGER_PCT,
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
