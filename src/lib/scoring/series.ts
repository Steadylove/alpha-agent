/**
 * Pine Script 序列函数的等价实现。
 *
 * 与 indicators.ts 的分工：indicators 返回最后一根 bar 的标量，本模块返回逐日序列。
 * MPR 的 ECDF 与跨 bar 状态递推必须拿到完整序列，故单开一个模块。
 *
 * 所有函数返回与输入等长的数组，数据不足的位置为 null。
 */

export function smaSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j += 1) {
      sum += values[j];
    }
    out[i] = sum / length;
  }
  return out;
}

/** 与 ta.ema 一致：第 length 根用 SMA 播种，其后 alpha = 2/(length+1) 递推。 */
export function emaSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < length) return out;

  let seed = 0;
  for (let j = 0; j < length; j += 1) {
    seed += values[j];
  }
  let prev = seed / length;
  out[length - 1] = prev;

  const alpha = 2 / (length + 1);
  for (let i = length; i < values.length; i += 1) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export function rocSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length; i < values.length; i += 1) {
    const base = values[i - length];
    out[i] = base === 0 ? null : ((values[i] - base) / base) * 100;
  }
  return out;
}

/** 与 ta.highest 一致：窗口含当前 bar。 */
export function highestSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i += 1) {
    let best = values[i - length + 1];
    for (let j = i - length + 2; j <= i; j += 1) {
      if (values[j] > best) best = values[j];
    }
    out[i] = best;
  }
  return out;
}

/** 与 ta.lowest 一致：窗口含当前 bar。 */
export function lowestSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length - 1; i < values.length; i += 1) {
    let best = values[i - length + 1];
    for (let j = i - length + 2; j <= i; j += 1) {
      if (values[j] < best) best = values[j];
    }
    out[i] = best;
  }
  return out;
}

/** 与 ta.rma 一致（Wilder 平滑）：SMA 播种，其后 alpha = 1/length 递推。 */
export function rmaSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < length) return out;

  let seed = 0;
  for (let j = 0; j < length; j += 1) seed += values[j];
  let prev = seed / length;
  out[length - 1] = prev;

  const alpha = 1 / length;
  for (let i = length; i < values.length; i += 1) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** 与 ta.tr(true) 一致：首根退化为 high - low。 */
export function trueRangeSeries(bars: { high: number; low: number; close: number }[]): number[] {
  return bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low;
    const prevClose = bars[i - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose),
    );
  });
}

/** 与 ta.atr 一致：真实波幅的 Wilder 平滑。 */
export function atrSeries(
  bars: { high: number; low: number; close: number }[],
  length: number,
): (number | null)[] {
  return rmaSeries(trueRangeSeries(bars), length);
}

/**
 * 与 ta.cross 一致：crossover 或 crossunder。
 * crossover 为 a > b 且 a[1] <= b[1]；crossunder 为 a < b 且 a[1] >= b[1]。
 * 任一操作数为 null 时记 false（Pine 中 na 参与比较结果为 false）。
 */
export function crossSeries(a: (number | null)[], b: (number | null)[]): boolean[] {
  const out: boolean[] = new Array(a.length).fill(false);
  for (let i = 1; i < a.length; i += 1) {
    const cur = a[i];
    const prev = a[i - 1];
    const curB = b[i];
    const prevB = b[i - 1];
    if (cur == null || prev == null || curB == null || prevB == null) continue;
    out[i] = (cur > curB && prev <= prevB) || (cur < curB && prev >= prevB);
  }
  return out;
}

/**
 * 与 ta.barssince 一致：距上一次条件为真的 bar 数，当根为真时记 0。
 * 从未为真时返回 null（对应 Pine 的 na，参与比较时结果为 false）。
 */
export function barsSinceSeries(cond: boolean[]): (number | null)[] {
  const out: (number | null)[] = new Array(cond.length).fill(null);
  let last = -1;
  for (let i = 0; i < cond.length; i += 1) {
    if (cond[i]) last = i;
    out[i] = last < 0 ? null : i - last;
  }
  return out;
}

/**
 * 与 ta.percentrank 一致：统计**之前** length 根中 <= 当前值的占比（×100）。
 * 注意窗口是 [i-length, i-1]，不含当前 bar —— 与 highest/lowest 的语义相反。
 */
export function percentRankSeries(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length; i < values.length; i += 1) {
    let count = 0;
    for (let j = i - length; j < i; j += 1) {
      if (values[j] <= values[i]) count += 1;
    }
    out[i] = (count / length) * 100;
  }
  return out;
}
