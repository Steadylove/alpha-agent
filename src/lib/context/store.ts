import { readSnapshot } from "@/lib/vps/snapshot";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { validDay } from "@/lib/catalyst/normalize";
import { parseContextReport } from "./normalize";
import { contextEvidenceHash, filterContextSummary } from "./summary";
import type { ContextReport, ContextSymbol } from "./types";

/** Read-only saved output. A missing historic date must never become today's information. */
export async function getContextReport(date?: string): Promise<ContextReport | null> {
  if (date !== undefined && !validDay(date)) return null;
  try {
    const name = `context/${date ?? "latest"}`, signal = AbortSignal.timeout(5000);
    let raw: unknown;
    if (marketBaseUrl()) {
      const body = await fetchMarketText(`snapshots/${name}.json`, signal);
      raw = body.trim() ? JSON.parse(body) : null;
    } else raw = await readSnapshot<unknown>(name, signal);
    if (raw == null) return null;
    const report = parseContextReport(raw);
    if (date && report.asOf !== date) return null;
    if (report.summaryStatus === "ready" && report.summary?.inputHash !== contextEvidenceHash(report)) return { ...report, summary: null, summaryStatus: "stale" };
    if (report.summaryStatus === "ready") {
      const summary = filterContextSummary(report, report.summary);
      return { ...report, summary, summaryStatus: summary ? "ready" : "unavailable" };
    }
    return report;
  } catch { return null; }
}

export async function getSymbolContext(symbol: string, date?: string): Promise<{ report: ContextReport; observation: ContextSymbol } | null> {
  const ticker = symbol.toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)) return null;
  const report = await getContextReport(date), observation = report?.observations.find(row => row.symbol === ticker);
  return report && observation ? { report, observation } : null;
}
