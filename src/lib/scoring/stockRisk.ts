/**
 * 个股动态移动风控与保本引擎。
 *
 * 对齐「MarketCompass」Pine 第 714~767 行。
 *
 * 与轮动雷达的 `rotationTrade.ts` 是**两套不同的风控**，不要混用：
 *
 * | | 轮动雷达 | 本模块 |
 * | --- | --- | --- |
 * | 仓位槽 | 单槽，一买二买抢同一个 | 双槽，一买与二买各自独立持有 |
 * | 移动止盈 | 固定 3×ATR 吊灯 | 三级收紧 5.5 → 3.8 → 2.8 ×ATR |
 * | ATR 口径 | ATR14 | sma(ATR14, 14)，再平滑一层 |
 * | 入场闸门 | RS >= 30 | sma(RSI14, 14) > 30 |
 *
 * Pine 里两条线名字叫「止损线」和「止盈线」，但后者初值在开仓价**下方**
 * （close − 5.5×ATR），实为第二条移动止损。这里沿用 Pine 的命名以便对照，
 * 但注释里按实际语义说明。
 */

import { atrSeries, rsiSeries, smaOfNullable } from "./series";

export interface RiskBar {
  high: number;
  low: number;
  close: number;
}

export interface StockRiskParams {
  atrLength: number;
  /** 初始硬止损，开仓价 − 该倍数 × ATR */
  stopLossMult: number;
  /** 移动止盈基准倍数，浮盈未达一级门槛时使用 */
  stopProfitMult: number;
  /** 浮盈达此百分比后把硬止损上移到开仓价 × 1.01 */
  breakevenTriggerPct: number;
  tightenLvl1Pct: number;
  tightenLvl1Mult: number;
  tightenLvl2Pct: number;
  tightenLvl2Mult: number;
  rsiLength: number;
  /** 平滑 RSI 低于此值时禁止开仓 */
  rsiMin: number;
  enableRsiFilter: boolean;
  /**
   * 商业化文档独有：Path 2 或 5 日下跌概率 >= 60% 时，保本触发提前到 +5%。
   * MarketCompass Pine 只有 +10%（第 34 行的 be_trigger_pct），默认关闭。
   */
  useEarlyBreakeven: boolean;
  /** 启用提前保本时，逐日提供当日宏观条件；未提供视为不满足。 */
  earlyBreakevenActive?: (index: number) => boolean;
}

/** 商业化文档第 217 行的提前保本档。 */
export const EARLY_BREAKEVEN_TRIGGER_PCT = 5;

/** 取自 Pine 第 28~38 行的 input 默认值。 */
export const DEFAULT_STOCK_RISK_PARAMS: StockRiskParams = {
  atrLength: 14,
  stopLossMult: 4.0,
  stopProfitMult: 5.5,
  breakevenTriggerPct: 10.0,
  tightenLvl1Pct: 20.0,
  tightenLvl1Mult: 3.8,
  tightenLvl2Pct: 40.0,
  tightenLvl2Mult: 2.8,
  rsiLength: 14,
  rsiMin: 30,
  enableRsiFilter: true,
  useEarlyBreakeven: false,
};

/** 单个仓位槽的状态，空仓时全为 null。 */
export interface RiskSlot {
  entryPrice: number | null;
  stopLossLevel: number | null;
  /** Pine 的 stopProfitLevel，实为第二条移动止损 */
  trailLevel: number | null;
  highestHigh: number | null;
  maxProfitPct: number | null;
  breakevenLocked: boolean;
  /**
   * 该槽是否在当根刚开仓。
   *
   * 仲裁引擎要区分「本根刚建仓」和「早已持仓」：Pine 的风控段跑在仲裁段之前，
   * 点火当根就把开仓价填上了，导致仲裁的第 2 层（买点触发）永远够不着。
   * 见 `tacticalGuide.ts`。
   */
  openedThisBar: boolean;
}

export interface StockRiskDay {
  buy1Slot: RiskSlot;
  buy2Slot: RiskSlot;
  /** 平滑 RSI，预热期为 null */
  smoothedRsi: number | null;
  rsiOk: boolean;
  /** 当日任一槽有持仓（含本根刚开的） */
  holding: boolean;
  /** 本根开仓之前就已持仓。仲裁引擎判「持仓优先」时读的是这个。 */
  heldBeforeThisBar: boolean;
}

export interface ClosedRiskTrade {
  slot: "buy1" | "buy2";
  entryIndex: number;
  entryPrice: number;
  exitIndex: number;
  exitPrice: number;
  pnlPct: number;
  barsHeld: number;
  /** 触发离场的是硬止损还是移动止损 */
  reason: "stop_loss" | "trail";
}

const emptySlot = (): RiskSlot => ({
  entryPrice: null,
  stopLossLevel: null,
  trailLevel: null,
  highestHigh: null,
  maxProfitPct: null,
  breakevenLocked: false,
  openedThisBar: false,
});

const snapshot = (s: RiskSlot): RiskSlot => ({ ...s });

/**
 * 逐日推进两个仓位槽。
 *
 * 复刻 Pine 的执行顺序：开仓 → 持仓管理 → 离场判定，三步都在同一根上跑完，
 * 因此开仓当根就会先把移动止损抬一次。
 */
export function computeStockRisk(
  bars: readonly RiskBar[],
  buy1: readonly boolean[],
  buy2: readonly boolean[],
  params: StockRiskParams = DEFAULT_STOCK_RISK_PARAMS,
): { days: StockRiskDay[]; closed: ClosedRiskTrade[] } {
  const n = bars.length;
  if (buy1.length !== n || buy2.length !== n) {
    throw new Error(`信号序列与 K 线长度不一致: ${buy1.length}/${buy2.length} vs ${n}`);
  }

  const closes = bars.map((b) => b.close);
  // Pine: atr_risk = sma(atr(14), 14)，rsi_val = sma(rsi(close,14), 14)
  const atr = smaOfNullable(atrSeries([...bars], params.atrLength), params.atrLength);
  const rsi = smaOfNullable(rsiSeries(closes, params.rsiLength), params.rsiLength);

  const slots = { buy1: emptySlot(), buy2: emptySlot() };
  const entryIndex = { buy1: -1, buy2: -1 };
  const days: StockRiskDay[] = [];
  const closed: ClosedRiskTrade[] = [];

  for (let i = 0; i < n; i += 1) {
    const bar = bars[i];
    const a = atr[i];
    const smoothedRsi = rsi[i];
    const rsiOk = params.enableRsiFilter ? smoothedRsi != null && smoothedRsi > params.rsiMin : true;

    const signals = { buy1: buy1[i], buy2: buy2[i] } as const;

    for (const key of ["buy1", "buy2"] as const) {
      const slot = slots[key];
      slot.openedThisBar = false;

      // 1. 开仓：该槽必须为空，且 ATR 已预热
      if (signals[key] && slot.entryPrice == null && rsiOk && a != null) {
        slot.entryPrice = bar.close;
        slot.stopLossLevel = bar.close - params.stopLossMult * a;
        slot.trailLevel = bar.close - params.stopProfitMult * a;
        slot.highestHigh = bar.high;
        slot.maxProfitPct = 0;
        slot.breakevenLocked = false;
        slot.openedThisBar = true;
        entryIndex[key] = i;
      }

      // 2. 持仓管理：开仓当根同样执行（Pine 无 else 分支）
      if (slot.entryPrice != null && a != null) {
        slot.highestHigh = Math.max(slot.highestHigh ?? bar.high, bar.high);
        slot.maxProfitPct = Math.max(
          slot.maxProfitPct ?? 0,
          ((bar.close - slot.entryPrice) / slot.entryPrice) * 100,
        );

        const mult =
          slot.maxProfitPct >= params.tightenLvl2Pct
            ? params.tightenLvl2Mult
            : slot.maxProfitPct >= params.tightenLvl1Pct
              ? params.tightenLvl1Mult
              : params.stopProfitMult;

        // 只上移不下移
        slot.trailLevel = Math.max(slot.trailLevel ?? -Infinity, slot.highestHigh - mult * a);

        const breakevenTrigger =
          params.useEarlyBreakeven && (params.earlyBreakevenActive?.(i) ?? false)
            ? EARLY_BREAKEVEN_TRIGGER_PCT
            : params.breakevenTriggerPct;
        if (slot.maxProfitPct >= breakevenTrigger) {
          const breakeven = slot.entryPrice * 1.01;
          if (breakeven > (slot.stopLossLevel ?? -Infinity)) {
            slot.stopLossLevel = breakeven;
            slot.breakevenLocked = true;
          }
        }
      }

      // 3. 离场：Pine 用 crossunder，即前一根在线上、当根跌破
      if (slot.entryPrice != null && i > 0) {
        const prevClose = closes[i - 1];
        const crossedTrail =
          slot.trailLevel != null && bar.close < slot.trailLevel && prevClose >= slot.trailLevel;
        const crossedStop =
          slot.stopLossLevel != null &&
          bar.close < slot.stopLossLevel &&
          prevClose >= slot.stopLossLevel;

        if (crossedTrail || crossedStop) {
          const idx = entryIndex[key];
          closed.push({
            slot: key,
            entryIndex: idx,
            entryPrice: slot.entryPrice,
            exitIndex: i,
            exitPrice: bar.close,
            pnlPct: ((bar.close - slot.entryPrice) / slot.entryPrice) * 100,
            barsHeld: i - idx,
            // Pine 先判 stopProfit 再判 stopLoss，两者同时触发时记前者
            reason: crossedTrail ? "trail" : "stop_loss",
          });
          slots[key] = emptySlot();
          entryIndex[key] = -1;
        }
      }
    }

    days.push({
      buy1Slot: snapshot(slots.buy1),
      buy2Slot: snapshot(slots.buy2),
      smoothedRsi,
      rsiOk,
      holding: slots.buy1.entryPrice != null || slots.buy2.entryPrice != null,
      heldBeforeThisBar:
        (slots.buy1.entryPrice != null && !slots.buy1.openedThisBar) ||
        (slots.buy2.entryPrice != null && !slots.buy2.openedThisBar),
    });
  }

  return { days, closed };
}
