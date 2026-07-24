import type { DailyBar } from "@/lib/types/market";

const stooqSymbol = (symbol: string) => `${symbol.toLowerCase()}.us`;

const parseCsv = (csv: string): DailyBar[] => {
  const lines = csv.trim().split("\n");
  const rows = lines.slice(1);

  return rows
    .map((line) => {
      const [date, open, high, low, close, volume] = line.split(",");

      if (!date || close === "N/D") {
        return null;
      }

      return {
        symbol: "",
        date,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume),
        source: "stooq",
      } satisfies DailyBar;
    })
    .filter((row): row is DailyBar => row !== null && Number.isFinite(row.close));
};

export async function fetchStooqDailyBars(symbol: string): Promise<DailyBar[]> {
  const url = `https://stooq.com/q/d/l/?s=${stooqSymbol(symbol)}&i=d`;
  const response = await fetch(url, { next: { revalidate: 60 * 60 } });

  if (!response.ok) {
    throw new Error(`Stooq request failed for ${symbol}: ${response.status}`);
  }

  const csv = await response.text();
  return parseCsv(csv).map((bar) => ({ ...bar, symbol }));
}
