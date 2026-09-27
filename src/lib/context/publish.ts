import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { snapshotDir } from "@/lib/vps/snapshot";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import { lastSettledNyDate } from "@/lib/backtest/mergeBars";
import { validDay } from "@/lib/catalyst/normalize";
import type { CatalystReport } from "@/lib/catalyst/types";
import { optionFlowOf, optionFlowPath } from "@/lib/optionFlow/store";
import { readLocalFlowCollectionHealth } from "@/lib/optionFlow/health";
import { normalizeFlowEvents, type FlowEvent } from "@/lib/optionFlow/research/events";
import { buildContextReport } from "./model";
import { parseContextReport } from "./normalize";
import { analyzeContext, contextEvidenceHash, type generateContextSummary } from "./summary";
import type { ContextCoverage, ContextReport } from "./types";

export function loadContextFlows(catalyst: CatalystReport): { flows: FlowEvent[]; coverage: ContextCoverage } {
  try {
    const file = optionFlowPath();
    if (!existsSync(file)) throw new Error("missing");
    const source = optionFlowOf(JSON.parse(readFileSync(file, "utf8")));
    if (!Number.isFinite(Date.parse(source.updatedAt)) || Date.parse(source.updatedAt) > Date.parse(catalyst.generatedAt)) throw new Error("invalid cutoff");
    const { events } = normalizeFlowEvents(source.posts, catalyst.sessions);
    const health = readLocalFlowCollectionHealth();
    const age = health ? Date.parse(catalyst.generatedAt) - Date.parse(health.checkedAt) : Infinity;
    // A successful current poll does not prove uninterrupted coverage of a historical window.
    // Keep available sample records even when fresh health is missing; never infer absence.
    const fresh = health?.state === "ok" && age >= 0 && age <= 30 * 60_000;
    const warnings = source.readWarnings ? " 部分旧记录字段或来源证明无效，已隔离或降为未知。" : "";
    return { flows: events, coverage: { state: "partial", checkedAt: source.updatedAt,
      detail: (fresh ? "频道最近一轮采集成功；仅为转述样本，未证明整个观察窗口完整覆盖。" : "已保存的频道样本可用；最近采集状态缺失、过期或失败，不能据此判断没有期权流。") + warnings } };
  } catch { return { flows: [], coverage: { state: "unavailable", checkedAt: null, detail: "期权流档案不可用；不能将缺失解释为没有资金活动。" } }; }
}

function archived(directory: string, report: ContextReport, bytes: Buffer) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const folder = path.join(directory, "context", "history", report.asOf);
  const file = path.join(folder, `${report.generatedAt.replace(/[:.]/g, "-")}-${digest.slice(0, 16)}.json`);
  mkdirSync(folder, { recursive: true });
  try { writeFileSync(file, bytes, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readFileSync(file).equals(bytes)) throw error; }
}

/** Exact previous bytes are retained before a date-keyed sidecar changes. */
export function saveContextReport(report: ContextReport, directory = snapshotDir(), name = report.asOf) {
  if (name !== "latest" && (name !== report.asOf || !validDay(name))) throw new Error("Context archive date invalid");
  const checked = parseContextReport(report, new Date(report.generatedAt));
  const file = path.join(directory, "context", `${name}.json`);
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    const previous = parseContextReport(JSON.parse(bytes.toString("utf8")), new Date(report.generatedAt));
    if (JSON.stringify(previous) === JSON.stringify(checked)) return;
    if (Date.parse(previous.generatedAt) > Date.parse(checked.generatedAt)) throw new Error("Context archive cannot move backward");
    if (name !== "latest") archived(directory, previous, bytes);
  }
  writeJsonAtomic(file, checked);
}

const readSaved = (directory: string, name: string, now: Date): ContextReport | null => {
  const file = path.join(directory, "context", `${name}.json`);
  return existsSync(file) ? parseContextReport(JSON.parse(readFileSync(file, "utf8")), now) : null;
};
function canPublishDate(catalyst: CatalystReport, directory: string) {
  try {
    const now = Date.parse(catalyst.generatedAt), settled = lastSettledNyDate(new Date(now - 20 * 60_000));
    if (catalyst.sessions.at(-1)! <= settled || catalyst.sessions.filter(day => day <= settled).at(-1) !== catalyst.asOf) return false;
    const index = z.object({ version: z.literal(1), latest: z.literal(catalyst.asOf) }).parse(JSON.parse(readFileSync(path.join(directory, "daily-review/index.json"), "utf8")));
    const review = z.object({ version: z.literal(1), date: z.literal(index.latest), builtAt: z.iso.datetime() }).parse(JSON.parse(readFileSync(path.join(directory, "daily-review", `${index.latest}.json`), "utf8")));
    return Date.parse(review.builtAt) <= now;
  } catch { return false; }
}

export type ContextPublication = { status: "saved" | "waiting" | "unavailable"; date: string; symbols: number; analysisFailed: boolean };
/** Runs only after independent Catalyst collection. Never writes original Review or trading inputs. */
export async function publishContextReport(catalyst: CatalystReport, options: {
  analyze?: boolean; refresh?: boolean; directory?: string; apiKey?: string; model?: string;
  now?: Date;
  loadFlows?: typeof loadContextFlows; generate?: typeof generateContextSummary;
} = {}): Promise<ContextPublication> {
  const directory = options.directory ?? snapshotDir(), now = options.now ?? new Date(), date = catalyst.asOf;
  if (!validDay(date)) return { status: "waiting", date, symbols: 0, analysisFailed: false };
  try {
    const inputs = (options.loadFlows ?? loadContextFlows)({ ...catalyst, generatedAt: now.toISOString() });
    const current = buildContextReport({ catalyst, flows: inputs.flows, flowCoverage: inputs.coverage, date, cutoff: now.toISOString() });
    const previous = readSaved(directory, date, now), previousLatest = readSaved(directory, "latest", now);
    const eligible = canPublishDate(catalyst, directory);
    // A failed source cannot erase a previously saved informative observation.
    const losesEvidence = previous && (
      previous.observations.some(row => row.events.length || row.flows.length) && !current.observations.some(row => row.events.length || row.flows.length) ||
      current.coverage.events.state === "unavailable" && previous.observations.some(row => row.events.length) ||
      current.coverage.flow.state === "unavailable" && previous.observations.some(row => row.flows.length));
    const refreshing = !previous || Boolean(options.refresh && eligible && !losesEvidence);
    const base = refreshing ? current : previous;
    const model = options.model || "deepseek-v4-pro";
    let selected = await analyzeContext(base, previous?.summary ?? previousLatest?.summary ?? null, { analyze: options.analyze && eligible, apiKey: options.apiKey, model, now, generate: options.generate });
    // AI may be added later to a frozen evidence cutoff, without changing its facts.
    const changed = !previous || refreshing || JSON.stringify(selected.summary) !== JSON.stringify(previous.summary) || selected.summaryStatus !== previous.summaryStatus;
    selected = { ...selected, generatedAt: changed ? now.toISOString() : previous.generatedAt,
      revision: (previous?.revision ?? (previous ? 1 : 0)) + Number(!previous || refreshing && contextEvidenceHash(previous) !== contextEvidenceHash(current)),
      originalCapturedAt: previous?.originalCapturedAt ?? previous?.cutoff ?? selected.cutoff,
      ...(previous && refreshing && previous.cutoff !== selected.cutoff ? { supersedesCutoff: previous.cutoff } : {}),
    };
    if (eligible) saveContextReport(selected, directory);
    const latest = await analyzeContext(current, selected.summary ?? previousLatest?.summary ?? null, { analyze: false, model, now });
    saveContextReport(latest, directory, "latest");
    return { status: eligible ? "saved" : "waiting", date, symbols: current.observations.length,
      analysisFailed: Boolean(eligible && options.analyze && selected.highlights.some(row => row.timeline.length) && selected.summaryStatus !== "ready") };
  } catch { return { status: "unavailable", date, symbols: 0, analysisFailed: Boolean(options.analyze) }; }
}
