import { fetchStooqDailyBars } from "@/lib/data-sources/stooq";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import type { DailyBar } from "@/lib/types/market";

export async function fetchDailyBars(symbol: string): Promise<DailyBar[]> {
  const errors: string[] = [];

  for (const fetcher of [fetchStooqDailyBars, fetchYahooDailyBars]) {
    try {
      const bars = await fetcher(symbol);
      if (bars.length > 0) {
        return bars;
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`No daily bars available for ${symbol}. ${errors.join(" | ")}`);
}

export async function fetchManyDailyBars(
  symbols: string[],
  options: { concurrency?: number } = {},
): Promise<{
  barsBySymbol: Map<string, DailyBar[]>;
  errors: Record<string, string>;
}> {
  const concurrency = options.concurrency ?? 8;
  const barsBySymbol = new Map<string, DailyBar[]>();
  const errors: Record<string, string> = {};

  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < symbols.length) {
      const index = cursor;
      cursor += 1;
      const symbol = symbols[index];
      try {
        const bars = await fetchDailyBars(symbol);
        barsBySymbol.set(symbol, bars);
      } catch (error) {
        errors[symbol] = error instanceof Error ? error.message : String(error);
      }
    }
  });

  await Promise.all(workers);

  return { barsBySymbol, errors };
}
