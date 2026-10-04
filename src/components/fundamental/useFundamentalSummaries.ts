"use client";

import { useEffect, useState } from "react";
import type { FundamentalSummaryData } from "@/lib/fundamental/types";

const unavailable = (symbol: string): FundamentalSummaryData => ({ symbol, status: "error", reasons: [],
  checkedAt: null, publishedAt: null, method: null, quote: null, currency: "USD", sixMonth: null, twelveMonth: null });

/** Separate read path: valuation failure never rejects a signal or account request. */
export function useFundamentalSummaries(symbols: string[]) {
  const key = [...new Set(symbols)].sort().join(",");
  const [result, setResult] = useState<{ key: string; rows: Record<string, FundamentalSummaryData>; loading: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const selected = key ? key.split(",") : [];
    void (async () => {
      const rows: Record<string, FundamentalSummaryData> = {};
      for (let i = 0; i < selected.length; i += 20) {
        const batch = selected.slice(i, i + 20);
        try {
          const response = await fetch(`/api/fundamental/summary?${new URLSearchParams({ symbols: batch.join(",") })}`, {
            signal: controller.signal, cache: "no-store",
          });
          if (!response.ok) throw new Error("Summary unavailable");
          const data = await response.json() as { rows: FundamentalSummaryData[] };
          for (const symbol of batch) rows[symbol] = data.rows.find(row => row.symbol === symbol) ?? unavailable(symbol);
        } catch {
          if (controller.signal.aborted) return;
          for (const symbol of batch) rows[symbol] = unavailable(symbol);
        }
        if (controller.signal.aborted) return;
        setResult({ key, rows: { ...rows }, loading: i + 20 < selected.length });
      }
    })();
    return () => controller.abort();
  }, [key]);
  return { rows: result?.key === key ? result.rows : {}, loading: Boolean(key) && (result?.key !== key || result.loading) };
}
