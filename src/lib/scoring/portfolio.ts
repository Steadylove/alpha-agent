import type { StockScore, WatchlistChange, WatchlistStatus } from "@/lib/types/market";

export function computeWatchlistChanges(
  todayScores: StockScore[],
  previousStatuses: Map<string, WatchlistStatus>,
): WatchlistChange[] {
  return todayScores.slice(0, 10).map((score) => {
    const previous = previousStatuses.get(score.symbol) ?? null;
    const current = score.status;

    let reason = "状态延续";
    if (previous == null) {
      reason = "新进入跟踪池";
    } else if (previous !== current) {
      reason = score.finalCompassScore >= 80 ? "评分增强" : "评分或排名走弱";
    }

    return {
      symbol: score.symbol,
      previous,
      current,
      reason,
      finalScore: score.finalCompassScore,
    };
  });
}
