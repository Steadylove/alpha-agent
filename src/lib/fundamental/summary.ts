import { getFundamentalPage } from "./store";
import type { FundamentalHorizon, FundamentalPageData, FundamentalSummaryData } from "./types";

const readError = "暂时无法读取有效基本面估值快照，请稍后重试。";

function horizon(value: FundamentalHorizon | undefined): FundamentalSummaryData["sixMonth"] {
  return value ? { weightedTarget: value.weightedTarget, rangeLow: value.rangeLow, rangeHigh: value.rangeHigh } : null;
}

function summarize(data: FundamentalPageData): FundamentalSummaryData {
  // A partially read page must never expose its previous target as a successful read.
  const state = data.error ? null : data.state;
  const current = state?.current;
  return {
    symbol: data.symbol,
    status: data.error ? "error" : state?.status ?? "missing",
    reasons: data.error ? [data.error] : state?.reasons ?? ["尚无已保存的基本面估值"],
    checkedAt: state?.checkedAt ?? null,
    publishedAt: current?.publishedAt ?? null,
    method: current?.method ?? null,
    quote: state?.latestQuote ?? current?.input.quote ?? null,
    currency: current?.input.currency ?? "",
    sixMonth: horizon(current?.sixMonth),
    twelveMonth: horizon(current?.twelveMonth),
    ...(data.demo ? { demo: true } : {}),
  };
}

/** Saved snapshots only; each batch limits reads and isolates unavailable symbols. */
export async function getFundamentalSummaries(symbols: string[]): Promise<FundamentalSummaryData[]> {
  const rows: FundamentalSummaryData[] = [];
  for (let offset = 0; offset < symbols.length; offset += 5) {
    rows.push(...await Promise.all(symbols.slice(offset, offset + 5).map(async symbol => {
      try {
        return summarize(await getFundamentalPage(symbol, { includeHistory: false }));
      } catch {
        return summarize({ symbol, state: null, history: [], atEntry: null, entryAt: null, error: readError });
      }
    })));
  }
  return rows;
}
