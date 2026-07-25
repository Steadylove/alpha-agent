import type { DailyBar } from "@/lib/types/market";

export function latest<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

export function simpleMovingAverage(values: number[], window: number): number | null {
  if (values.length < window) {
    return null;
  }

  const slice = values.slice(-window);
  return slice.reduce((sum, value) => sum + value, 0) / window;
}

export function percentChange(values: number[], lookback: number): number | null {
  if (values.length <= lookback) {
    return null;
  }

  const current = values[values.length - 1];
  const previous = values[values.length - 1 - lookback];

  if (!previous) {
    return null;
  }

  return (current - previous) / previous;
}

/**
 * O'Neil 系 RPS 分位：
 *   RPS = (1 - Rank / N) × 100
 * Rank = 按涨幅降序的名次（涨幅严格更高的数量 + 1；并列时共享靠前名次）
 * 例：5000 只里第 500 名 → (1 - 500/5000)×100 = 90
 */
export function percentileRank(value: number, universe: number[]): number {
  if (universe.length === 0) {
    return 0;
  }

  const better = universe.filter((item) => item > value).length;
  const rank = better + 1;
  return (1 - rank / universe.length) * 100;
}

export function highestHigh(bars: DailyBar[], lookback: number): number | null {
  if (bars.length < lookback) {
    return null;
  }

  return Math.max(...bars.slice(-lookback).map((bar) => bar.high));
}

export function positionScore(bar: DailyBar): number {
  const range = bar.high - bar.low;
  if (range <= 0) {
    return 0;
  }

  return (bar.close - bar.low) / range;
}

export function chaikinMoneyFlow(bars: DailyBar[], window: number): number | null {
  if (bars.length < window) {
    return null;
  }

  const slice = bars.slice(-window);
  const moneyFlowVolume = slice.reduce((sum, bar) => {
    const range = bar.high - bar.low;
    const multiplier = range === 0 ? 0 : ((bar.close - bar.low) - (bar.high - bar.close)) / range;
    return sum + multiplier * bar.volume;
  }, 0);
  const volume = slice.reduce((sum, bar) => sum + bar.volume, 0);

  return volume === 0 ? null : moneyFlowVolume / volume;
}

export function averageTrueRange(bars: DailyBar[], window: number): number | null {
  if (bars.length <= window) {
    return null;
  }

  const slice = bars.slice(-window - 1);
  const trueRanges = slice.slice(1).map((bar, index) => {
    const previousClose = slice[index].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
  });

  return trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;
}

export function pocketPivot(bars: DailyBar[]): boolean {
  if (bars.length < 11) {
    return false;
  }

  const current = bars[bars.length - 1];
  const previous = bars.slice(-11, -1);
  const largestDownVolume = Math.max(
    ...previous
      .filter((bar, index) => index === 0 || bar.close < previous[index - 1].close)
      .map((bar) => bar.volume),
    0,
  );

  return current.close > current.open && current.volume > largestDownVolume;
}

/**
 * Up Day Ratio: 过去 N 天收阳线的比例（0~1）
 * v3 白皮书 Trend 结构 3 分项，反映"平滑稳步推进"
 */
export function upDayRatio(bars: DailyBar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const slice = bars.slice(-period);
  const upDays = slice.filter((bar, i) => {
    const prev = i === 0 ? bars[bars.length - period - 1] : slice[i - 1];
    return bar.close > prev.close;
  }).length;
  return upDays / period;
}

/**
 * Max Drawdown Recent: 最近 N 天内高点到低点最大回撤（负值，如 -0.15 = -15%）
 * v3 白皮书 Trend 结构 3 分项，反映"路径质量"
 */
export function maxDrawdownRecent(bars: DailyBar[], period: number): number | null {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  let peak = slice[0].close;
  let maxDd = 0;
  for (const bar of slice) {
    if (bar.close > peak) peak = bar.close;
    const dd = (bar.close - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd;
}

/**
 * Event Ratio: 过去 N 天内 (最大单日涨幅) / (ATR14/close)
 * v3 白皮书 Momentum 异常过滤：值越大越可能是并购/财报脉冲而非趋势
 */
export function eventRatio(bars: DailyBar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const atr = averageTrueRange(bars, 14);
  const lastClose = bars[bars.length - 1].close;
  if (atr == null || lastClose <= 0) return null;

  const slice = bars.slice(-period);
  let maxSingle = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const prev = i === 0 ? bars[bars.length - period - 1] : slice[i - 1];
    const ret = (slice[i].close - prev.close) / prev.close;
    if (ret > maxSingle) maxSingle = ret;
  }

  const atrNorm = atr / lastClose;
  if (atrNorm <= 0) return null;
  return maxSingle / atrNorm;
}

/**
 * Selling Pressure: 过去 N 天中下跌日成交量 / 全部成交量
 * v3 白皮书 Capital Flow：机构建仓的核心特征是下跌极度缩量（供应锁定）
 */
export function sellingPressure(bars: DailyBar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const slice = bars.slice(-period);
  let downVol = 0;
  let totalVol = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const prev = i === 0 ? bars[bars.length - period - 1] : slice[i - 1];
    const bar = slice[i];
    totalVol += bar.volume;
    if (bar.close < prev.close) downVol += bar.volume;
  }
  return totalVol === 0 ? null : downVol / totalVol;
}

/**
 * Recent Resistance: 过去 N 天内的最高价（用作 60D 交易目标价的阻力位）
 */
export function recentResistance(bars: DailyBar[], lookback: number): number | null {
  return highestHigh(bars, lookback);
}
