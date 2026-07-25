import type { MarketMetric } from "@/lib/types/market";

export type EnvironmentBreakdown = {
  score: number; // 0~15
  mssScore: number; // 0~5
  breadthScore: number; // 0~5
  creditScore: number; // 0~5
};

/**
 * v3 白皮书 顶层 15%：市场环境（MSS 5 + Breadth 5 + Credit 5）
 * 直接把 MarketMetric 里已算好的 4 因子 25 分制归一到 5 分制
 *
 * 同 stock 打分不同：市场环境是全市场共享的，所有股票拿到相同的 env 分
 */
export function computeEnvironment(metric: MarketMetric): EnvironmentBreakdown {
  const norm = (score: number | null): number => {
    if (score == null) return 0;
    return Math.round((score / 25) * 5);
  };

  const mssScore = norm(metric.skewScore) + norm(metric.pcrScore);
  // MSS 5 分 = SKEW(尾部) + PCR/VIX(风险偏好) 归一，各 2.5 分，合计 5
  const mss5 = Math.min(5, Math.round(mssScore / 2));

  const breadth5 = norm(metric.breadthScore);
  const credit5 = norm(metric.creditScore);

  return {
    score: mss5 + breadth5 + credit5,
    mssScore: mss5,
    breadthScore: breadth5,
    creditScore: credit5,
  };
}
