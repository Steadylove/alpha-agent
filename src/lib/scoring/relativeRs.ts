/**
 * 个股相对强度评分（对标基准指数，1~99）。
 *
 * 对齐「MarketCompass」Pine 第 110~135 行。
 *
 * 全项目第四种 RS 口径，四者互不通用：
 *   - 本模块        0.10/0.40/0.30/0.20 @ 21/63/126/252，对标 SPX 比率，饱和映射
 *   - rotationRs    0.20/0.40/0.20/0.20 @ 21/63/126/252，无基准，饱和映射
 *   - MPR Pine      0.40/0.20/0.20/0.20 @ 63/126/189/252，对标 SPX，7 段分段映射
 *   - 产品文档      与本模块权重相同，但要求全池截面分位而非饱和映射
 */

export const RELATIVE_RS_TERMS = [
  { lookback: 21, weight: 0.1 },
  { lookback: 63, weight: 0.4 },
  { lookback: 126, weight: 0.3 },
  { lookback: 252, weight: 0.2 },
] as const;

const SATURATION = 28;

/** 单周期比率，历史不足或基准为 0 时记 1.0（Pine 语义）。 */
function perfRatio(values: readonly number[], index: number, lookback: number): number {
  const base = values[index - lookback];
  if (base == null || base === 0) return 1;
  return values[index] / base;
}

function ratingAt(
  closes: readonly number[],
  benchmark: readonly number[],
  index: number,
): number {
  let total = 0;
  for (const { lookback, weight } of RELATIVE_RS_TERMS) {
    const stock = perfRatio(closes, index, lookback);
    const bench = perfRatio(benchmark, index, lookback);
    // Pine: 基准比率为 0 时该项记 100
    total += weight * (bench === 0 ? 100 : (stock / bench) * 100);
  }

  const alphaPct = total - 100;
  const raw = 50 + 48 * (alphaPct / (Math.abs(alphaPct) + SATURATION));
  return Math.min(99, Math.max(1, raw));
}

/**
 * 逐日 RS 评分。closes 与 benchmark 必须已按同一交易日轴对齐、等长。
 */
export function relativeRsSeries(
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

/** 21 日比率不弱于 63 日比率视为动能加速。 */
export function isRsAccelerating(
  closes: readonly number[],
  benchmark: readonly number[],
  index: number,
): boolean {
  const item = (lookback: number) => {
    const bench = perfRatio(benchmark, index, lookback);
    return bench === 0 ? 100 : (perfRatio(closes, index, lookback) / bench) * 100;
  };
  return item(21) >= item(63);
}
