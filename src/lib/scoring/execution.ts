import {
  averageTrueRange,
  latest,
  sellingPressure as computeSellingPressure,
  simpleMovingAverage,
} from "@/lib/scoring/indicators";
import { computePwfv, computeTradingTarget } from "@/lib/scoring/valuation";
import type { DailyBar, ExecutionPlan, StockScore } from "@/lib/types/market";

export type ExecutionBreakdown = {
  score: number; // 0~15
  gbzZoneScore: number; // 0~8
  sellingPressureScore: number; // 0~4
  stopRatioScore: number; // 0~3
  distanceToGbz: number | null; // 当前价距 GBZ 中枢的相对位置（正数 = 高于）
  sellingPressure20d: number | null;
  stopLossRatio: number | null;
};

/**
 * v3 白皮书 Golden Buy Zone
 * (SMA20 + SMA50 + TWAP20) / 3 × [0.988, 1.012]
 */
export function computeGoldenBuyZone(bars: DailyBar[]): { low: number; high: number } | null {
  if (bars.length < 20) return null;

  const closes = bars.map((bar) => bar.close);
  const sma20 = simpleMovingAverage(closes, 20);
  const sma50 = simpleMovingAverage(closes, 50) ?? sma20;
  const twap20 = simpleMovingAverage(
    bars.slice(-20).map((bar) => (bar.high + bar.low + bar.close) / 3),
    20,
  );
  if (sma20 == null || sma50 == null || twap20 == null) return null;

  const anchor = (sma20 + sma50 + twap20) / 3;
  return { low: anchor * 0.988, high: anchor * 1.012 };
}

/**
 * v3 白皮书 硬核止损：close - 2 × ATR14
 */
export function computeDynamicStopLoss(bars: DailyBar[]): number | null {
  const lastBar = latest(bars);
  if (!lastBar) return null;
  const atr = averageTrueRange(bars, 14);
  if (atr == null) return null;
  return lastBar.close - 2 * atr;
}

// ──────────────── v3 Execution 打分（15 分，每只股票都算） ────────────────

/**
 * GBZ 位置分 8：
 *  - 当前价在 GBZ 内 → 8 分（可回踩建仓）
 *  - 距离 GBZ 上沿 0-3% → 5 分（等待回踩）
 *  - 3-8% → 2 分
 *  - > 8% → 0 分（追高一票否决）
 */
function scoreGbzPosition(currentPrice: number, gbz: { low: number; high: number }): number {
  if (currentPrice <= gbz.high) return 8;
  const distance = (currentPrice - gbz.high) / gbz.high;
  if (distance <= 0.03) return 5;
  if (distance <= 0.08) return 2;
  return 0;
}

/**
 * Selling Pressure 分 4：
 *  - < 35% → 4 分（机构强锁仓）
 *  - 35-50% → 2 分
 *  - > 50% → 0 分（供应压力大）
 */
function scoreSellingPressure(sp: number | null): number {
  if (sp == null) return 0;
  if (sp < 0.35) return 4;
  if (sp <= 0.5) return 2;
  return 0;
}

/**
 * 止损比合理性 3：
 *  - 止损空间 ≤ 8% → 3 分
 *  - 8-15% → 2 分
 *  - > 15% → 0 分（波动过大）
 */
function scoreStopRatio(stopRatio: number | null): number {
  if (stopRatio == null) return 0;
  if (stopRatio <= 0.08) return 3;
  if (stopRatio <= 0.15) return 2;
  return 0;
}

export function computeExecution(bars: DailyBar[]): ExecutionBreakdown {
  const lastBar = latest(bars);
  const gbz = computeGoldenBuyZone(bars);
  const stopLoss = computeDynamicStopLoss(bars);
  const sp = computeSellingPressure(bars, 20);

  if (!lastBar || !gbz) {
    return {
      score: 0,
      gbzZoneScore: 0,
      sellingPressureScore: 0,
      stopRatioScore: 0,
      distanceToGbz: null,
      sellingPressure20d: sp,
      stopLossRatio: null,
    };
  }

  const price = lastBar.close;
  const gbzMid = (gbz.low + gbz.high) / 2;
  const distance = (price - gbzMid) / gbzMid;
  const stopRatio = stopLoss != null ? (price - stopLoss) / price : null;

  const gbzZoneScore = scoreGbzPosition(price, gbz);
  const sellingPressureScore = scoreSellingPressure(sp);
  const stopRatioScore = scoreStopRatio(stopRatio);

  return {
    score: gbzZoneScore + sellingPressureScore + stopRatioScore,
    gbzZoneScore,
    sellingPressureScore,
    stopRatioScore,
    distanceToGbz: distance,
    sellingPressure20d: sp,
    stopLossRatio: stopRatio,
  };
}

// ──────────────── 完整 ExecutionPlan（只对 Top 5 算，包含估值 + Trading Target） ────────────────

export function computeExecutionPlan(
  bars: DailyBar[],
  stockScore: StockScore,
  analystTargetPrice: number | null = null,
): ExecutionPlan | null {
  const lastBar = latest(bars);
  const zone = computeGoldenBuyZone(bars);
  const stop = computeDynamicStopLoss(bars);
  if (!lastBar || !zone || stop == null) return null;

  const price = lastBar.close;
  // v3 双价格解耦：6-12M PWFV
  const closes = bars.map((b) => b.close);
  const momentum20d =
    closes.length >= 21
      ? (closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21]
      : null;
  const pwfv = computePwfv(price, analystTargetPrice, momentum20d);

  // v3 60D 波段交易目标价
  const tradingTarget = computeTradingTarget(bars, price);
  const rrr = tradingTarget?.rewardRiskRatio ?? 0;
  const expectedReturn60d = tradingTarget
    ? (tradingTarget.target - price) / price
    : (pwfv.weightedFair - price) / price;

  // 波动率：20D 日 std × √60
  const returns: number[] = [];
  for (let i = Math.max(1, closes.length - 20); i < closes.length; i += 1) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  const mean = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const variance =
    returns.length > 0
      ? returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length
      : 0;
  const dailyStd = Math.sqrt(variance);
  const expectedVolatility60d = dailyStd * Math.sqrt(60);

  return {
    symbol: stockScore.symbol,
    currentPrice: Number(price.toFixed(2)),
    signalConfidence: stockScore.finalCompassScore,
    positionSizePercent: Math.min(20, Math.max(0, stockScore.finalCompassScore / 5)),
    goldenBuyLow: Number(zone.low.toFixed(2)),
    goldenBuyHigh: Number(zone.high.toFixed(2)),
    stopLoss: Number(stop.toFixed(2)),
    expectedReturn60d,
    expectedVolatility60d,
    rewardRiskRatio: Number(rrr.toFixed(2)),
    valuation: {
      bear: pwfv.bear,
      base: pwfv.base,
      bull: pwfv.bull,
      weightedFair: pwfv.weightedFair,
      safetyMargin: pwfv.safetyMargin,
      score: pwfv.score * 10, // 0-100 展示口径
    },
  };
}
