import { readSnapshot } from "@/lib/vps/snapshot";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { fingerprint, parseCatalystReport } from "./normalize";
import { catalystEvidence } from "./summary";
import type { CatalystPageData } from "./types";

/** Page reads saved output only; a visit never collects news or spends model tokens. */
export async function getCatalystPage(now = new Date()): Promise<CatalystPageData> {
  try {
    const signal = AbortSignal.timeout(8000);
    // An empty remote response must not fall back to a build-time local archive.
    let raw: unknown;
    if (marketBaseUrl()) {
      const text = await fetchMarketText("snapshots/catalyst/latest.json", signal);
      raw = text.trim() ? JSON.parse(text) : null;
    } else raw = await readSnapshot<unknown>("catalyst/latest", signal);
    if (!raw) return { report: null, error: "事件快照尚未生成。后台采集完成后会在这里显示。", stale: false };
    const report = parseCatalystReport(raw);
    const age = now.getTime() - Date.parse(report.generatedAt);
    if (age < -60_000) throw new Error("future snapshot");
    if (report.summaryStatus === "ready") {
      if (!report.summary || Date.parse(report.summary.generatedAt) > Date.parse(report.generatedAt) + 60_000) report.summaryStatus = "unavailable";
      else if (report.summary.inputHash !== fingerprint(catalystEvidence(report, new Date(report.generatedAt)))) report.summaryStatus = "stale";
    }
    return { report, error: null, stale: age > 2 * 60 * 60_000 };
  } catch {
    return { report: null, error: "暂时无法读取有效事件快照，请稍后刷新。", stale: false };
  }
}
