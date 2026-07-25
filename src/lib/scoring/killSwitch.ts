import type { FundamentalSnapshot } from "@/lib/data-sources/fmp";
import type { DailyBar } from "@/lib/types/market";

export type KillSwitchResult = {
  passed: boolean;
  reason: string | null;
};

const PASSED: KillSwitchResult = { passed: true, reason: null };

/**
 * v3 白皮书 模块零：投资一票否决熔断器
 * 命中任意一条 → 直接 Score = 0，不参与评分与推荐。
 *
 * 免费数据源可覆盖 6/8 条量化熔断：
 *   1. 12M 内并股 (Reverse Split)
 *   2. 市值 < $1B
 *   3. 20D 平均日成交额 (ADTV) < $30M
 *   4. 12M 增发稀释 > 15%
 *   5. Gross Margin 连续 2 季下降
 *   6. 21D 内单日涨幅 > 30%（无催化剂判断，宁可误伤）
 *
 * 放弃 2 条（需 LLM/新闻语义）：
 *   - 无 SEC 披露的并购传闻
 *   - 连续下修 Guidance
 */
export function evaluateKillSwitch(
  bars: DailyBar[],
  fundamentals?: FundamentalSnapshot,
): KillSwitchResult {
  // Rule 1: 12M 内并股
  if (fundamentals?.reverseSplit12m) {
    return { passed: false, reason: "12M 内发生反向拆股 (Reverse Split)" };
  }

  // Rule 2: 市值 < $1B（S&P 500 全部满足，实际由 universe 上游过滤，不再打 API）
  if (fundamentals?.marketCap != null && fundamentals.marketCap < 1_000_000_000) {
    return {
      passed: false,
      reason: `市值 $${(fundamentals.marketCap / 1_000_000_000).toFixed(2)}B < $1B`,
    };
  }

  // Rule 3: 20D 平均日成交额 < $30M
  if (bars.length >= 20) {
    const recent20 = bars.slice(-20);
    const adtv =
      recent20.reduce((sum, bar) => sum + bar.close * bar.volume, 0) / recent20.length;
    if (adtv < 30_000_000) {
      return { passed: false, reason: `20D ADTV $${(adtv / 1_000_000).toFixed(1)}M < $30M` };
    }
  }

  // Rule 4: 12M 增发稀释 > 15%
  if (
    fundamentals?.sharesDilution12m != null &&
    fundamentals.sharesDilution12m > 0.15
  ) {
    return {
      passed: false,
      reason: `12M 增发稀释 +${(fundamentals.sharesDilution12m * 100).toFixed(1)}% > 15%`,
    };
  }

  // Rule 5: GM 连续 2 季下降
  if (fundamentals && fundamentals.gmDecliningStreak >= 2) {
    return {
      passed: false,
      reason: `Gross Margin 连续 ${fundamentals.gmDecliningStreak} 季下降`,
    };
  }

  // Rule 6: 21D 内单日涨幅 > 30%（防事件脉冲）
  if (bars.length >= 22) {
    const recent21 = bars.slice(-21);
    for (let i = 0; i < recent21.length; i += 1) {
      const prev = i === 0 ? bars[bars.length - 22] : recent21[i - 1];
      const ret = (recent21[i].close - prev.close) / prev.close;
      if (ret > 0.3) {
        return {
          passed: false,
          reason: `21D 内单日涨幅 +${(ret * 100).toFixed(1)}% > 30%（事件脉冲嫌疑）`,
        };
      }
    }
  }

  return PASSED;
}
