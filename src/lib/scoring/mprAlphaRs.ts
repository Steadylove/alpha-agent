/**
 * MPR 口径的 4Q-Alpha 相对强度评分（1~99）。
 *
 * 对齐「Market Phase Radar」Pine 第 30~60 行。
 *
 * 全项目第三种 RS 口径，与另外三种互不通用，数值不可互比：
 *   - 本模块        0.40/0.20/0.20/0.20 @ 63/126/189/252，先各自加权再相除，7 段分段映射
 *   - relativeRs    0.10/0.40/0.30/0.20 @ 21/63/126/252，逐项相除再加权，饱和映射
 *   - rotationRs    0.20/0.40/0.20/0.20 @ 21/63/126/252，无基准，饱和映射
 *   - 产品文档      权重同 relativeRs，但要求全池截面分位
 *
 * 注意本模块与 `relativeRs` 的关键结构差异：Pine 在这里是把个股与 SPX 的
 * 四周期比率**各自加权求和之后**再相除（第 41~44 行），而 `relativeRs` 是
 * 逐周期相除再加权。两者在代数上不等价。
 */

export const MPR_ALPHA_TERMS = [
  { lookback: 63, weight: 0.4 },
  { lookback: 126, weight: 0.2 },
  { lookback: 189, weight: 0.2 },
  { lookback: 252, weight: 0.2 },
] as const;

/** Pine 第 47~53 行的七段分段映射断点：[分数下界, 评分下界, 评分跨度]。 */
const RATING_BREAKPOINTS = [
  { minScore: 195.93, base: 99, span: 0, width: 0 },
  { minScore: 117.11, base: 90, span: 8.9, width: 195.93 - 117.11 },
  { minScore: 99.04, base: 70, span: 19.9, width: 117.11 - 99.04 },
  { minScore: 91.66, base: 50, span: 19.9, width: 99.04 - 91.66 },
  { minScore: 80.96, base: 30, span: 19.9, width: 91.66 - 80.96 },
  { minScore: 53.64, base: 10, span: 19.9, width: 80.96 - 53.64 },
  { minScore: 24.86, base: 2, span: 7.9, width: 53.64 - 24.86 },
] as const;

/** 单周期比率，历史不足或基准为 0 时记 1.0（Pine 语义）。 */
function perfRatio(values: readonly number[], index: number, lookback: number): number {
  const base = values[index - lookback];
  if (base == null || base === 0) return 1;
  return values[index] / base;
}

/** Pine 的 `f_calc_alpha_rating`：把相对分数映射到 1~99。 */
export function alphaRating(score: number): number {
  for (const bp of RATING_BREAKPOINTS) {
    if (score >= bp.minScore) {
      const rating = bp.width === 0 ? bp.base : bp.base + ((score - bp.minScore) / bp.width) * bp.span;
      return Math.min(99, Math.max(1, rating));
    }
  }
  return 1;
}

function ratingAt(closes: readonly number[], benchmark: readonly number[], index: number): number {
  let stockWeighted = 0;
  let benchWeighted = 0;
  for (const { lookback, weight } of MPR_ALPHA_TERMS) {
    stockWeighted += weight * perfRatio(closes, index, lookback);
    benchWeighted += weight * perfRatio(benchmark, index, lookback);
  }
  // Pine 第 44 行：基准加权和非正时整体记 100（即与基准持平）
  const score = benchWeighted > 0 ? (stockWeighted / benchWeighted) * 100 : 100;
  return alphaRating(score);
}

/** 逐日评分。closes 与 benchmark 必须已按同一交易日轴对齐、等长。 */
export function mprAlphaRsSeries(
  closes: readonly number[],
  benchmark: readonly number[],
): number[] {
  if (closes.length !== benchmark.length) {
    throw new Error(
      `个股与基准序列长度不一致: ${closes.length} vs ${benchmark.length}，请先按交易日对齐`,
    );
  }
  return closes.map((_, i) => ratingAt(closes, benchmark, i));
}

/**
 * Pine 第 60 行的空头排列判定：`close < ema20 and ema20 < ema50`。
 *
 * 注意这里用的是 EMA20/50 的短期排列，不是 EMA200 长周期趋势——
 * 它比 `momentumGates` 的 `isInLongDowntrend`（EMA850 + RS<40）灵敏得多。
 */
export function inShortTermDowntrend(
  close: number,
  ema20: number | null,
  ema50: number | null,
): boolean {
  if (ema20 == null || ema50 == null) return false;
  return close < ema20 && ema20 < ema50;
}
