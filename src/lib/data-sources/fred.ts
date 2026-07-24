export type FredObservation = {
  date: string;
  value: number;
};

type FredResponse = {
  observations?: Array<{
    date: string;
    value: string;
  }>;
};

export async function fetchFredSeries(seriesId: string): Promise<FredObservation[]> {
  const apiKey = process.env.FRED_API_KEY;

  if (!apiKey) {
    return [];
  }

  const url = new URL("https://api.stlouisfed.org/fred/series/observations");
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "desc");
  url.searchParams.set("limit", "90");

  const response = await fetch(url, { next: { revalidate: 24 * 60 * 60 } });

  if (!response.ok) {
    throw new Error(`FRED request failed for ${seriesId}: ${response.status}`);
  }

  const payload = (await response.json()) as FredResponse;
  return (payload.observations ?? [])
    .map((row) => ({
      date: row.date,
      value: Number(row.value),
    }))
    .filter((row) => Number.isFinite(row.value));
}
