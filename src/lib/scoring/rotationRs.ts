/**
 * 4Q-Alpha 动能评分（RS 1~99）。
 *
 * 严格对齐「美股动能满仓轮动雷达」Pine 第 111~116 行：四周期加权涨幅经饱和函数映射。
 * 注意这与 MPR Pine 的 rs_rating 不是同一指标——后者是对标 SPX 的比率再走分段映射，
 * 二者不可互换。
 */

export type RotationRsTerm = { lookback: number; weight: number };

export const ROTATION_RS_TERMS: readonly RotationRsTerm[] = [
  { lookback: 21, weight: 0.2 },
  { lookback: 63, weight: 0.4 },
  { lookback: 126, weight: 0.2 },
  { lookback: 252, weight: 0.2 },
];

/** 饱和常数：加权涨幅达到该值（百分比）时评分偏离中位一半。 */
const SATURATION = 28;

function ratingAt(closes: readonly number[], index: number): number {
  const current = closes[index]!;

  let weightedPerf = 0;
  for (const { lookback, weight } of ROTATION_RS_TERMS) {
    const baseIndex = index - lookback;
    // Pine: 历史不足或基准为 0 时该周期记 0，而非跳过。
    if (baseIndex < 0) continue;
    const base = closes[baseIndex]!;
    if (base === 0) continue;
    weightedPerf += weight * ((current - base) / base);
  }
  weightedPerf *= 100;

  const raw = 50 + 48 * (weightedPerf / (Math.abs(weightedPerf) + SATURATION));
  return Math.min(99, Math.max(1, raw));
}

/** 逐日 RS 评分，长度与输入一致。 */
export function rotationRsSeries(closes: readonly number[]): number[] {
  return closes.map((_, i) => ratingAt(closes, i));
}

/** 最新一根的 RS 评分；空序列返回 null。 */
export function rotationRsRating(closes: readonly number[]): number | null {
  if (closes.length === 0) return null;
  return ratingAt(closes, closes.length - 1);
}
