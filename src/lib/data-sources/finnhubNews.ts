import type { Instrument, NewsItem } from "@/lib/types/market";

type FinnhubNewsRow = {
  id?: number;
  category?: string;
  datetime?: number;
  headline?: string;
  image?: string;
  related?: string;
  source?: string;
  summary?: string;
  url?: string;
};

const toDateString = (timestampSeconds: number) =>
  new Date(timestampSeconds * 1000).toISOString().slice(0, 10);

const relatedSymbolsFor = (row: FinnhubNewsRow, universe: Instrument[]) => {
  const text = `${row.headline ?? ""} ${row.summary ?? ""} ${row.related ?? ""}`.toUpperCase();
  return universe
    .filter((instrument) => text.includes(instrument.symbol) || text.includes(instrument.name.toUpperCase()))
    .map((instrument) => instrument.symbol);
};

export async function fetchFinnhubMarketNews(input: {
  category?: string;
  universe: Instrument[];
  limit?: number;
}): Promise<NewsItem[]> {
  const apiKey = process.env.FINNHUB_API_KEY;

  if (!apiKey) {
    return [];
  }

  const category = input.category ?? "general";
  const url = new URL("https://finnhub.io/api/v1/news");
  url.searchParams.set("category", category);
  url.searchParams.set("token", apiKey);

  let response: Response;
  try {
    response = await fetch(url, { next: { revalidate: 30 * 60 } });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const rows = (await response.json()) as FinnhubNewsRow[];
  return rows
    .filter((row) => row.id != null && row.headline && row.url && row.datetime)
    .map((row) => ({
      externalId: String(row.id),
      date: toDateString(row.datetime ?? 0),
      source: row.source ?? "Finnhub",
      category: row.category ?? category,
      headline: row.headline ?? "",
      summary: row.summary ?? null,
      url: row.url ?? "",
      imageUrl: row.image || null,
      relatedSymbols: relatedSymbolsFor(row, input.universe),
      publishedAt: new Date((row.datetime ?? 0) * 1000).toISOString(),
    }))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, input.limit ?? 20);
}
