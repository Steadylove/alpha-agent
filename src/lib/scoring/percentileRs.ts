/**
 * 全池截面分位 RS，对齐「商业化产品架构闭环」第 146~148 行。
 *
 * `RS_i = PercentileRank(AlphaScore_i, Universe) ∈ [1, 99]`
 *
 * 与项目里另外三套 RS 的根本区别：那三套都是**逐股独立**的数学映射，
 * 一只股票的分数与池子里其他股票无关；这一套是**截面排名**，
 * 同样的绝对涨幅在强势市场里会得到更低的分数。
 *
 * 三份 Pine 都没有这个口径（TradingView 单图表拿不到全池数据），
 * 因此默认不启用，见 `config/commercialSpec.ts`。
 */

/**
 * 把一组原始强度分转成 1~99 的截面分位。
 *
 * 采用「严格小于 + 半个并列」的中位排名法处理并列，避免全体同分时
 * 所有标的都拿 1 或 99 这种退化结果——全同分时每只都得 50。
 */
export function percentileRank(scores: readonly number[]): number[] {
  const n = scores.length;
  if (n === 0) return [];
  if (n === 1) return [50];

  return scores.map((s) => {
    let below = 0;
    let equal = 0;
    for (const other of scores) {
      if (other < s) below += 1;
      else if (other === s) equal += 1;
    }
    const rank = (below + equal / 2) / n;
    return Math.min(99, Math.max(1, rank * 100));
  });
}

/**
 * 截面口径的 4Q-Alpha：先算各标的的四周期加权超额，再做全池分位。
 *
 * 权重与 `relativeRs` 相同（商业化文档第 141~147 行与 MarketCompass Pine 一致），
 * 差别只在最后一步用分位排名替换饱和映射。
 */
export const PERCENTILE_RS_TERMS = [
  { lookback: 21, weight: 0.1 },
  { lookback: 63, weight: 0.4 },
  { lookback: 126, weight: 0.3 },
  { lookback: 252, weight: 0.2 },
] as const;

function perfRatio(values: readonly number[], index: number, lookback: number): number {
  const base = values[index - lookback];
  if (base == null || base === 0) return 1;
  return values[index] / base;
}

/** 单只标的在某一日的原始超额分，未做分位。 */
export function alphaScoreAt(
  closes: readonly number[],
  benchmark: readonly number[],
  index: number,
): number {
  let total = 0;
  for (const { lookback, weight } of PERCENTILE_RS_TERMS) {
    const bench = perfRatio(benchmark, index, lookback);
    total += weight * (bench === 0 ? 100 : (perfRatio(closes, index, lookback) / bench) * 100);
  }
  return total;
}

/**
 * 全池某一日的截面 RS。
 *
 * `universe` 的每一项是一只标的已与基准对齐的收盘价序列，
 * 返回值与入参同序。
 */
export function crossSectionalRs(
  universe: readonly { closes: readonly number[]; index: number }[],
  benchmark: readonly number[],
): number[] {
  return percentileRank(universe.map((u) => alphaScoreAt(u.closes, benchmark, u.index)));
}

/**
 * 按交易日做截面排名，产出每只标的的逐日 RS 序列。
 *
 * 各标的的上市时间与停牌日不同，不能按下标对齐，必须按日期。
 * 某一日只在**当日有数据的标的之间**排名——用全池长度当分母会让
 * 新上市标的把老标的的分位系统性压低。
 *
 * 返回 `symbol -> 与该标的 dates 等长的 RS 序列`。
 */
export function percentileRsBySymbol(
  universe: readonly { symbol: string; dates: readonly string[]; closes: readonly number[] }[],
  benchmark: { dates: readonly string[]; closes: readonly number[] },
): Map<string, number[]> {
  const benchIndexOf = new Map(benchmark.dates.map((d, i) => [d, i]));
  const out = new Map(universe.map((u) => [u.symbol, new Array(u.dates.length).fill(50)]));

  const allDates = [...new Set(universe.flatMap((u) => [...u.dates]))].sort();
  const cursor = new Map(universe.map((u) => [u.symbol, new Map(u.dates.map((d, i) => [d, i]))]));

  for (const date of allDates) {
    const bi = benchIndexOf.get(date);
    if (bi == null) continue;

    const present = universe.flatMap((u) => {
      const i = cursor.get(u.symbol)!.get(date);
      return i == null ? [] : [{ symbol: u.symbol, index: i, closes: u.closes }];
    });
    if (present.length === 0) continue;

    const scores = percentileRank(
      present.map((p) => alphaScoreAt(p.closes, benchmark.closes, p.index)),
    );
    present.forEach((p, k) => {
      out.get(p.symbol)![p.index] = scores[k];
    });
  }

  return out;
}
