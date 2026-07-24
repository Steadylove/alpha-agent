import type { DailyBar } from "@/lib/types/market";

export function makeBars(symbol: string, start: number, step: number, days = 260): DailyBar[] {
  return Array.from({ length: days }, (_, index) => {
    const close = start + step * index;
    const date = new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);

    return {
      symbol,
      date,
      open: close * 0.99,
      high: close * 1.02,
      low: close * 0.98,
      close,
      volume: 1_000_000 + index * 1_000,
      source: "fixture",
    };
  });
}
