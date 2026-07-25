import type { SectorScore, WatchlistStatus } from "@/lib/types/market";

/**
 * 白皮书 §5 信号置信度 → 星级（严格四档）：
 *   ≥ 90 : ⭐⭐⭐⭐⭐  强烈关注（动态仓位上限最高 20%）
 *   ≥ 80 : ⭐⭐⭐⭐    准备低吸（等待回踩 Golden Buy Zone）
 *   ≥ 70 : ⭐⭐⭐      中性观察（暂不急于介入）
 *   else : ⭐         风险偏高 / 不配置
 */
export function starsFromScore(score: number): string {
  if (score >= 90) return "⭐⭐⭐⭐⭐";
  if (score >= 80) return "⭐⭐⭐⭐";
  if (score >= 70) return "⭐⭐⭐";
  return "⭐";
}

export function signalLabel(score: number): string {
  if (score >= 90) return "强烈关注";
  if (score >= 80) return "准备低吸";
  if (score >= 70) return "中性观察";
  return "风险偏高";
}

/**
 * 前 3 名奖牌，其余用序号
 */
export function medalForRank(rank: number): string {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `${rank}.`;
}

/**
 * 白皮书 "仓位分配 = f(Final Score, 预期盈亏比) 动态计算"
 * 基线仓位 = score / 5（92 → 18.4%），然后按 R:R 缩放：
 *   R:R >= 2  → 100% 基线
 *   R:R = 1   →  70% 基线
 *   R:R = 0   →  0
 * 结果封顶 20%。
 */
export function positionCapPercent(score: number, rewardRiskRatio: number | null = null): number {
  const base = Math.min(20, Math.max(0, score / 5));
  if (rewardRiskRatio == null) return Math.round(base * 10) / 10;
  const rrFactor = Math.min(1, Math.max(0, 0.4 + 0.3 * rewardRiskRatio));
  return Math.round(base * rrFactor * 10) / 10;
}

/**
 * 板块动能状态：短期强于中期→动能增强；否则结构改善
 */
export function sectorMomentumLabel(sector: SectorScore): string {
  if (sector.rs21 > sector.rs63) return "🔥 动能增强";
  return "🟢 结构改善";
}

const STATUS_LABEL: Record<WatchlistStatus, string> = {
  FOCUS: "🟢 核心关注",
  NEW: "🆕 新加入",
  WATCH: "🟡 观察",
  DOWNGRADED: "🔴 降级",
};

export function watchlistStatusLabel(status: WatchlistStatus): string {
  return STATUS_LABEL[status];
}

export function signedPercent(value: number, digits = 2): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}
