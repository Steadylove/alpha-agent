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
