import { averageTrueRange, recentResistance } from "@/lib/scoring/indicators";
import type { DailyBar } from "@/lib/types/market";

export type PwfvBreakdown = {
  bear: number;
  base: number;
  bull: number;
  weightedFair: number;
  safetyMargin: number;
  score: number; // 0~10
  source: "analyst-consensus" | "fallback-momentum";
};

export type TradingTargetBreakdown = {
  target: number;
  stopLoss: number;
  rewardRiskRatio: number;
  score: number; // 0~10
};

/**
 * v3 白皮书 模块三：6-12M PWFV 概率加权公允价
 * 用 FMP price-target-consensus 作为 Base，±25% 撑起 Bear/Bull（免费替代方案）
 * 权重：Bear 20% / Base 55% / Bull 25%
 *
 * 无分析师目标价时降级：用当前价 × (1 + 20D 动量 × 3) 作为 Base 兜底
 */
export function computePwfv(
  currentPrice: number,
  analystTargetPrice: number | null,
  momentum20d: number | null = null,
): PwfvBreakdown {
  let base: number;
  let source: PwfvBreakdown["source"];

  if (analystTargetPrice != null && analystTargetPrice > 0) {
    base = analystTargetPrice;
    source = "analyst-consensus";
  } else {
    const boost = momentum20d != null ? Math.max(-0.15, Math.min(0.15, momentum20d * 3)) : 0;
    base = currentPrice * (1 + boost);
    source = "fallback-momentum";
  }

  const bear = base * 0.75;
  const bull = base * 1.25;
  const weightedFair = 0.2 * bear + 0.55 * base + 0.25 * bull;
  const safetyMargin = (weightedFair - currentPrice) / currentPrice;

  // v3 得分映射（10 分制）
  let score = 0;
  if (safetyMargin >= 0.2) score = 10;
  else if (safetyMargin >= 0.1) score = 7;
  else if (safetyMargin >= 0.05) score = 5;
  else if (safetyMargin >= 0) score = 3;
  else if (safetyMargin >= -0.1) score = 1;

  return {
    bear: Number(bear.toFixed(2)),
    base: Number(base.toFixed(2)),
    bull: Number(bull.toFixed(2)),
    weightedFair: Number(weightedFair.toFixed(2)),
    safetyMargin,
    score,
    source,
  };
}

/**
 * v3 白皮书 模块三：60D 波段交易目标价 & RRR
 *
 * Trading Target = min(60D 阻力位, current + 1.5 × ATR14 × √60)
 * Stop Loss = current - 2 × ATR14
 * RRR = (Target - current) / (current - StopLoss)
 *
 * 得分映射：RRR ≥ 2 → 10 分；1-2 → 5 分；<1 → 0 分
 */
export function computeTradingTarget(
  bars: DailyBar[],
  currentPrice: number,
): TradingTargetBreakdown | null {
  const atr = averageTrueRange(bars, 14);
  const resistance = recentResistance(bars, 60);
  if (atr == null || resistance == null) return null;

  const upside = currentPrice + 1.5 * atr * Math.sqrt(60);
  const target = Math.min(resistance, upside);
  const stopLoss = currentPrice - 2 * atr;

  const reward = Math.max(0, target - currentPrice);
  const risk = Math.max(0.001, currentPrice - stopLoss);
  const rrr = reward / risk;

  let score = 0;
  if (rrr >= 2) score = 10;
  else if (rrr >= 1.5) score = 8;
  else if (rrr >= 1) score = 5;
  else if (rrr >= 0.5) score = 2;

  return {
    target: Number(target.toFixed(2)),
    stopLoss: Number(stopLoss.toFixed(2)),
    rewardRiskRatio: Number(rrr.toFixed(2)),
    score,
  };
}
