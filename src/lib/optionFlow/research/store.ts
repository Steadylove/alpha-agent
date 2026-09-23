import { existsSync, readFileSync } from "node:fs";
import { marketBaseUrl, rpsScaleFile, rpsSnapshotFile } from "@/lib/backtest/marketStore";
import { fetchMarketText, loadMarketPanel } from "@/lib/backtest/marketRemote";
import { readDeskJson } from "@/lib/fund/deskRemote";
import { optionFlowOf, optionFlowPath } from "../store";
import { snapshotFile, writeSnapshot } from "@/lib/vps/snapshot";
import { lastSettledSession } from "@/lib/backtest/mergeBars";
import type { RpsScaleFile } from "@/lib/backtest/rpsScale";
import type { RpsSnapshot } from "@/lib/backtest/rpsSnapshot";
import { normalizeFlowEvents } from "./events";
import { buildFlowResearch, flowOutcomes, type ResearchInputs, type FlowResearch, type FlowOutcome } from "./model";

export type ResearchPage = { report: FlowResearch | null; dates: string[]; outcomes: FlowOutcome[]; error: string | null };
type Index = { version: 1; dates: string[]; latest: string; updatedAt: string };
type Payload = { report: FlowResearch; outcomes: FlowOutcome[] };
const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const localJson = <T>(file: string): T | null => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : null;
async function inputJson<T>(relative: string, file: string): Promise<T | null> {
  if (!marketBaseUrl()) return localJson<T>(file);
  const text = await fetchMarketText(relative, AbortSignal.timeout(10000));
  return text ? JSON.parse(text) as T : null;
}
async function readArchive<T>(name: string) {
  return inputJson<T>(`snapshots/flow-research/${name}.json`, snapshotFile(`flow-research/${name}`));
}

export async function loadResearchInputs(): Promise<ResearchInputs> {
  // Remote errors stay errors: never silently use the stale repository copy.
  const raw = marketBaseUrl() && !process.env.OPTION_FLOW_PATH
    ? await readDeskJson("option-flow.json", AbortSignal.timeout(10000))
    : localJson(optionFlowPath());
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { posts?: unknown }).posts)) throw new Error("异常期权流来源尚未就绪");
  const flow = optionFlowOf(raw);
  const warnings: string[] = [];
  const [scale, rps, spy] = await Promise.all([
    inputJson<RpsScaleFile>("rps/rps-scale-spx.json", rpsScaleFile()).catch(() => { warnings.push("RPS 历史标尺暂不可用。"); return null; }),
    inputJson<RpsSnapshot>("rps/rps-latest.json", rpsSnapshotFile()).catch(() => { warnings.push("最新 RPS 快照暂不可用。"); return null; }),
    loadMarketPanel("1d", "SPY", AbortSignal.timeout(10000)),
  ]);
  if (!spy?.dates.length) throw new Error("缺少 SPY 日线，无法核验交易日及后续收益");
  const settled = lastSettledSession();
  const sessions = [...new Set([...spy.dates, ...(rps?.calendar?.sessions ?? [])])].filter(validDay).sort();
  const normalized = normalizeFlowEvents(flow.posts, sessions);
  const tickers = [...new Set(normalized.events.filter(e => e.day <= settled).map(e => e.ticker))];
  const panels: ResearchInputs["panels"] = new Map([["SPY", spy]]);
  const missing: string[] = [];
  for (let i = 0; i < tickers.length; i += 6) {
    await Promise.all(tickers.slice(i, i + 6).filter(t => t !== "SPY").map(async ticker => {
      try { const panel = await loadMarketPanel("1d", ticker, AbortSignal.timeout(25000)); if (panel) panels.set(ticker, panel); else missing.push(ticker); }
      catch { missing.push(ticker); }
    }));
  }
  if (missing.length) warnings.push(`行情源尚缺 ${missing.length} 个标的日线：${missing.slice(0, 12).sort().join(" / ")}${missing.length > 12 ? "…" : ""}。`);
  return { flow, scale, rps, panels, sessions, warnings };
}

function sourceDates(inputs: ResearchInputs) {
  const settled = lastSettledSession();
  return normalizeFlowEvents(inputs.flow.posts, inputs.sessions).observed.filter(d => d <= settled);
}

// A deployment can render from existing raw records before the first scheduled archive.
// This is read-only, visibly reconstructed, bounded-cache, and does not publish messages.
let preview: { key: string; until: number; pending: Promise<ResearchInputs> } | null = null;
function previewInputs() {
  const key = `${marketBaseUrl()}|${optionFlowPath()}|${rpsScaleFile()}`;
  if (!preview || preview.key !== key || preview.until < Date.now()) {
    const pending = loadResearchInputs();
    preview = { key, until: Date.now() + 120000, pending };
    void pending.catch(() => { if (preview?.pending === pending) preview = null; });
  }
  return preview.pending;
}

export async function getFlowResearchPage(requested?: string): Promise<ResearchPage> {
  let dates: string[] = [];
  try {
    if (requested && !validDay(requested)) return { report: null, dates, outcomes: [], error: "日期格式无效。" };
    const index = await readArchive<Index>("index");
    if (index?.version === 1 && index.dates.every(validDay)) {
      dates = index.dates;
      const date = requested ?? index.latest;
      if (!dates.includes(date)) return { report: null, dates, outcomes: [], error: "该日还没有研究归档，请选择已有日期。" };
      const payload = await readArchive<Payload>(date);
      if (payload?.report?.version !== 1 || payload.report.date !== date) throw new Error("研究归档不完整");
      const stale = !requested && date < lastSettledSession() ? `研究归档目前截至 ${date}，最近已收盘日为 ${lastSettledSession()}，等待收盘任务更新。` : null;
      return { ...payload, dates, error: stale };
    }
    const inputs = await previewInputs();
    dates = sourceDates(inputs);
    const date = requested ?? dates.at(-1);
    if (!date || !dates.includes(date)) return { report: null, dates, outcomes: [], error: "该日还没有可用来源记录，请选择已有日期。" };
    const reports = dates.filter(d => d <= date).slice(-21).map(d => buildFlowResearch(inputs, d));
    return { report: reports.at(-1)!, dates, outcomes: flowOutcomes(reports.slice(0, -1), inputs, date),
      error: !requested && date < lastSettledSession() ? `来源记录目前截至 ${date}，等待最新交易日数据。` : null };
  } catch (e) {
    return { report: null, dates, outcomes: [], error: `研究数据暂不可用：${e instanceof Error ? e.message : "读取失败"}。请稍后重试。` };
  }
}

/** Write facts once; subsequent runs only update derived evaluation up to each report's date. */
export async function archiveFlowResearch(daily = false, rebuild = false) {
  const inputs = await loadResearchInputs();
  const dates = sourceDates(inputs);
  if (!dates.length) throw new Error("没有可归档的期权流交易日");
  const oldIndex = localJson<Index>(snapshotFile("flow-research/index"));
  const allDates = [...new Set([...dates, ...(oldIndex?.dates ?? [])])].sort();
  const reports: FlowResearch[] = [];
  for (const date of allDates) {
    const previous = localJson<Payload>(snapshotFile(`flow-research/${date}`));
    if (rebuild && previous) writeSnapshot(`flow-research/backups/${Date.now()}/${date}`, previous);
    const report = !rebuild && previous?.report ? previous.report : buildFlowResearch(inputs, date);
    if (!previous && daily && date === lastSettledSession()) report.origin = "archived";
    reports.push(report);
    writeSnapshot(`flow-research/${date}`, { report, outcomes: flowOutcomes(reports.slice(-21, -1), inputs, date) } satisfies Payload);
  }
  const index: Index = { version: 1, dates: allDates, latest: allDates.at(-1)!, updatedAt: new Date().toISOString() };
  writeSnapshot("flow-research/index", index);
  return { days: dates.length, latest: index.latest, events: reports.reduce((s, r) => s + r.events.length, 0), warnings: inputs.warnings };
}
