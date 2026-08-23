/**
 * 全市场截面 RPS 百分位排名，日线。口径见策略规格「阶段二」：
 *
 * ```
 * Score_raw = 0.10×Perf_21D + 0.40×Perf_63D + 0.30×Perf_126D + 0.20×Perf_252D
 * RPS_i     = PercentileRank(Score_raw_i, Universe) ∈ [1, 99]
 * ```
 *
 * 四段都是**截至当日往回看**的累计区间涨跌幅，不是各区间的分段涨幅：
 * Perf_126D 为「收盘价 ÷ 126 根前的收盘价」，而非第 63~126 根那一段单独的表现。
 *
 * 用**绝对**涨跌幅、不除基准：相对强弱由**截面排名**这一步产生，不需要再除一次。
 * 除基准并不等价于一次单调变换——同一日里四段除的是四个**不同**的基准增长因子，
 * 等于按 1/gf_bench(L) 重新加权四项，排名会因此改变。
 *
 * 实现上用涨幅比 `close/base × 100`（走平得 100）而非规格里的涨跌幅 `Perf`。
 * 因权重和为 1，两者恒差常数 100，且对每只标的相同，截面排名完全一致。
 *
 * 与项目里另外三套 RS 的根本区别：那三套都是**逐股独立**的数学映射，
 * 一只股票的分数与池子里其他股票无关；这一套是**截面排名**，
 * 同样的绝对涨幅在强势市场里会得到更低的分数。
 */

/**
 * 未排名标记。分位下界被夹到 1，所以 0 不会与任何真实分位撞车，
 * `rs >= 门槛` 这类判断会自然排除它，无需额外的掩码数组。
 */
export const UNRANKED = 0;

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

/** 回看根数与权重，对应 1 / 3 / 6 / 12 个月，权重和为 1。 */
export const PERCENTILE_RS_TERMS = [
  { lookback: 21, weight: 0.1 },
  { lookback: 63, weight: 0.4 },
  { lookback: 126, weight: 0.3 },
  { lookback: 252, weight: 0.2 },
] as const;

/**
 * 单只标的在某一日的原始强度分，未做分位。走平的标的得 100。
 *
 * 四段回看任一落空即返回 NaN，表示不可评分。不能把落空的那段按「走平」计入：
 * 那等于断言该股上市前走平，会让新上市或新分拆的标的在入池头一年拿到失真的分数。
 * 因此满 252 根才给分。
 */
export function alphaScoreAt(closes: readonly number[], index: number): number {
  let total = 0;
  for (const { lookback, weight } of PERCENTILE_RS_TERMS) {
    const base = closes[index - lookback];
    if (base == null || base === 0) return NaN;
    total += weight * (closes[index] / base) * 100;
  }
  return total;
}

/**
 * 全池某一日的截面 RPS。`universe` 每一项是一只标的的收盘价序列与当日下标，
 * 返回值与入参同序。
 */
export function crossSectionalRs(
  universe: readonly { closes: readonly number[]; index: number }[],
): number[] {
  const scores = universe.map((u) => alphaScoreAt(u.closes, u.index));

  // 回看未齐的标的不能进排名：NaN 参与比较时 below 与 equal 都为 0，
  // 它自己会拿到下界，还会把分母抬高，把其他标的的分位一起压低。
  const rankable = scores.map((s, i) => ({ s, i })).filter((x) => !Number.isNaN(x.s));
  const ranks = percentileRank(rankable.map((x) => x.s));

  const out = new Array<number>(scores.length).fill(UNRANKED);
  rankable.forEach((x, k) => {
    out[x.i] = ranks[k];
  });
  return out;
}

/**
 * 按交易日做截面排名，产出每只标的的逐日 RS 序列。
 *
 * 各标的的上市时间与停牌日不同，不能按下标对齐，必须按日期。
 * 某一日只在**当日有数据且四段回看都齐的标的之间**排名——用全池长度当分母
 * 会让新上市标的把老标的的分位系统性压低。
 *
 * 返回 `symbol -> 与该标的 dates 等长的 RS 序列`，回看未齐的位置为 `UNRANKED`。
 */
export function percentileRsBySymbol(
  universe: readonly { symbol: string; dates: readonly string[]; closes: readonly number[] }[],
): Map<string, number[]> {
  const out = new Map(universe.map((u) => [u.symbol, new Array(u.dates.length).fill(UNRANKED)]));

  const allDates = [...new Set(universe.flatMap((u) => [...u.dates]))].sort();
  const cursor = new Map(universe.map((u) => [u.symbol, new Map(u.dates.map((d, i) => [d, i]))]));

  for (const date of allDates) {
    const present = universe.flatMap((u) => {
      const i = cursor.get(u.symbol)!.get(date);
      if (i == null) return [];
      const score = alphaScoreAt(u.closes, i);
      return Number.isNaN(score) ? [] : [{ symbol: u.symbol, index: i, score }];
    });
    if (present.length === 0) continue;

    const scores = percentileRank(present.map((p) => p.score));
    present.forEach((p, k) => {
      out.get(p.symbol)![p.index] = scores[k];
    });
  }

  return out;
}
