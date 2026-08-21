/**
 * 估值引擎的两个前置开关。
 *
 * 对齐「MarketCompass」Pine 第 153~156 行：
 *
 * ```
 * is_in_long_downtrend = close < ema850 and dailyRSRating < 40
 * peak_rs_60           = highest(dailyRSRating, 60)
 * is_former_leader     = not downtrend and ((peak_rs_60 >= 75 and rs >= 65)
 *                                        or (perfTicker252 >= 1.35 and rs >= 65))
 * is_hyper_momentum    = not downtrend and (rs >= 80 or tfAlpha >= 12
 *                                        or close/ema200 >= 1.30 or is_former_leader)
 * ```
 *
 * `tfAlpha` 跑在 4 小时线上（Pine 第 140~151 行的 `request.security(..., '240', ...)`），
 * 是四项里唯一需要日线以外数据的。它只是 `is_hyper_momentum` 四个「或」条件之一，
 * 缺失时由 `tfAlpha: null` 表达，等价于该条件不成立。
 *
 * 附带一处 Pine 的冗余（不影响行为，仅记录）：`rs >= 80` 这一条恒被
 * `is_former_leader` 蕴含。因为 `peak_rs_60 = highest(rs, 60) >= rs`，
 * 所以 `rs >= 80` 必然同时满足 `peak_rs_60 >= 75` 与 `rs >= 65`；
 * 两者的前置门（非长期下行）也相同。原样保留。
 */

export interface MomentumGates {
  isInLongDowntrend: boolean;
  isFormerLeader: boolean;
  isHyperMomentum: boolean;
  peakRs60: number;
  /** 252 日累计涨幅比率，历史不足时记 1.0 */
  perf252: number;
}

export interface MomentumGateInput {
  closes: readonly number[];
  /** 与 closes 同长的 dailyRSRating 序列 */
  rsRatings: readonly number[];
  index: number;
  /** 4H 相对 alpha，无 4H 数据时传 null */
  tfAlpha: number | null;
  ema200: number | null;
  ema850: number | null;
}

export function computeMomentumGates(input: MomentumGateInput): MomentumGates {
  const { closes, rsRatings, index, tfAlpha, ema200, ema850 } = input;
  const close = closes[index];
  const rs = rsRatings[index];

  const base252 = index - 252 >= 0 ? closes[index - 252] : null;
  const perf252 = base252 != null && base252 !== 0 ? close / base252 : 1.0;

  let peakRs60 = rs;
  for (let i = Math.max(0, index - 59); i <= index; i += 1) {
    if (rsRatings[i] > peakRs60) peakRs60 = rsRatings[i];
  }

  const isInLongDowntrend = close < (ema850 ?? close) && rs < 40;

  const isFormerLeader =
    !isInLongDowntrend && ((peakRs60 >= 75 && rs >= 65) || (perf252 >= 1.35 && rs >= 65));

  const isHyperMomentum =
    !isInLongDowntrend &&
    (rs >= 80 ||
      (tfAlpha != null && tfAlpha >= 12) ||
      close / (ema200 ?? close) >= 1.3 ||
      isFormerLeader);

  return { isInLongDowntrend, isFormerLeader, isHyperMomentum, peakRs60, perf252 };
}

/**
 * 4H 相对 alpha：`0.6 × (20 根相对涨幅差) + 0.4 × (50 根相对涨幅差)`。
 *
 * 两个序列必须已按 4H bar 对齐并等长。历史不足 50 根时返回 null——
 * Pine 在 `na` 时会把分项记 0，那样算出来的 alpha 会假性接近 0 并让门槛
 * 恒不成立；返回 null 让调用方明确知道这一项不可用，语义更干净。
 */
export function fourHourAlpha(
  closes: readonly number[],
  benchmark: readonly number[],
): number | null {
  const n = closes.length;
  if (n !== benchmark.length) {
    throw new Error(`4H 个股与基准序列长度不一致: ${n} vs ${benchmark.length}`);
  }
  if (n < 51) return null;

  const relGain = (series: readonly number[], lag: number) => {
    const base = series[n - 1 - lag];
    return base === 0 ? 0 : ((series[n - 1] - base) / base) * 100;
  };

  const alpha1 = relGain(closes, 20) - relGain(benchmark, 20);
  const alpha2 = relGain(closes, 50) - relGain(benchmark, 50);
  return 0.6 * alpha1 + 0.4 * alpha2;
}
