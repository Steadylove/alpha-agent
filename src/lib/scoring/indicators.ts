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

export function percentileRank(value: number, universe: number[]): number {
  if (universe.length === 0) {
    return 0;
  }

  const belowOrEqual = universe.filter((item) => item <= value).length;
  return (belowOrEqual / universe.length) * 100;
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
