import { parseCsvText, readCsvPanel } from "./csvPanel";
import type { MarketTimeframe } from "./marketStore";
import { csvDir, marketBaseUrl } from "./marketStore";
import type { PanelBars } from "./panel";

const CONCURRENCY = 8;

function urlOf(relPath: string): string {
  const base = marketBaseUrl();
  if (!base) throw new Error("MARKET_DATA_BASE_URL 未设");
  return `${base}/${relPath}`;
}

export async function fetchMarketText(relPath: string): Promise<string> {
  const response = await fetch(urlOf(relPath), { cache: "no-store" });
  if (response.status === 404) return "";
  if (!response.ok) {
    throw new Error(`行情服务 ${relPath} HTTP ${response.status}`);
  }
  return response.text();
}

/** 单票：配了行情机就走 VPS，否则读本地 CSV。 */
export async function loadMarketPanel(
  timeframe: MarketTimeframe,
  ticker: string,
): Promise<PanelBars | null> {
  if (marketBaseUrl()) {
    const remote = await fetchRemoteCsvPanel(timeframe, ticker);
    if (remote) return remote;
  }
  return readCsvPanel(csvDir(timeframe), ticker);
}

export async function fetchRemoteCsvPanel(
  timeframe: MarketTimeframe,
  ticker: string,
): Promise<PanelBars | null> {
  const text = await fetchMarketText(`${timeframe}/${ticker}.csv`);
  if (!text) return null;
  return parseCsvText(ticker, text);
}

export async function fetchRemoteCsvPanels(
  timeframe: MarketTimeframe,
  tickers: readonly string[],
): Promise<PanelBars[]> {
  const out: PanelBars[] = [];
  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const chunk = await Promise.all(
      tickers.slice(i, i + CONCURRENCY).map((ticker) => fetchRemoteCsvPanel(timeframe, ticker)),
    );
    for (const panel of chunk) if (panel) out.push(panel);
  }
  return out;
}
