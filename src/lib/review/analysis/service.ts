import { existsSync, readFileSync } from "node:fs";
import { snapshotFile, writeSnapshot } from "@/lib/vps/snapshot";
import type { DailyReview, JournalArchive } from "../types";
import { ANALYSIS_VERSION, type AnalysisReport } from "./types";
import { analysisHash, isAnalysisDate, prepareAnalysisInput } from "./fingerprint";
import { DEFAULT_ANALYSIS_MODEL, generateAnalysis, parseAnalysisReport } from "./model";
import { PROMPT_VERSION } from "./prompt";

type Dependencies = {
  read: (name: string) => unknown;
  write: (name: string, value: unknown) => void;
  generate: typeof generateAnalysis;
  now: () => Date;
};
const defaults: Dependencies = {
  read(name) {
    const file = snapshotFile(`daily-review/${name}`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  },
  write: (name, value) => writeSnapshot(`daily-review/${name}`, value),
  generate: generateAnalysis,
  now: () => new Date(),
};

function sourceFor(date: string, deps: Dependencies) {
  const review = deps.read(date) as DailyReview | null;
  if (!review || review.version !== 1 || review.date !== date ||
      !Number.isFinite(Date.parse(review.builtAt)) || Date.parse(review.builtAt) > deps.now().getTime() ||
      !review.market || !Array.isArray(review.signals) || !Array.isArray(review.options) ||
      !Array.isArray(review.accounts) || !Array.isArray(review.sectors))
    throw new Error("缺少该交易日的有效复盘，分析未生成");
  let journal: JournalArchive | null = null;
  try { journal = deps.read("journal") as JournalArchive | null; } catch { /* Clearly marked incomplete in evidence. */ }
  return prepareAnalysisInput(review, journal);
}

/** Data-only job. No mutations of reviews, journals, strategies or message delivery. */
export async function buildReviewAnalysis(options: {
  date: string; apiKey?: string; model?: string; force?: boolean; dryRun?: boolean;
}, overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  if (!isAnalysisDate(options.date)) throw new Error("分析日期无效");
  const date = options.date;
  const model = options.model || DEFAULT_ANALYSIS_MODEL;
  const input = sourceFor(date, deps);
  const summary = { date, model, inputHash: input.inputHash, facts: input.evidence.facts.length };
  if (options.dryRun) return { status: "dry-run" as const, ...summary };
  let previous: AnalysisReport | null = null;
  try { previous = parseAnalysisReport(deps.read(`analysis/${date}`), date); } catch { /* Absent/invalid prior result is not a cache hit. */ }
  if (!options.force && previous?.inputHash === input.inputHash && previous.sourceHash === input.sourceHash &&
      previous.promptVersion === PROMPT_VERSION && previous.model === model &&
      analysisHash(previous.evidence) === previous.inputHash)
    return { status: "cached" as const, ...summary };
  if (!options.apiKey?.trim()) throw new Error("每日分析未配置 DEEPSEEK_REVIEW_API_KEY（或 DEEPSEEK_API_KEY）");
  const result = await deps.generate(input.evidence, { apiKey: options.apiKey, model });
  const latest = sourceFor(date, deps);
  if (latest.sourceHash !== input.sourceHash || latest.inputHash !== input.inputHash)
    throw new Error("复盘在分析期间发生更新，本次结果未发布，请重新生成");
  const report = parseAnalysisReport({
    version: ANALYSIS_VERSION, date, generatedAt: deps.now().toISOString(),
    sourceBuiltAt: input.evidence.sourceBuiltAt, sourceHash: input.sourceHash, inputHash: input.inputHash,
    promptVersion: PROMPT_VERSION, model, evidence: input.evidence, output: result.output, usage: result.usage,
  }, date);
  // Keep the prior successful edition when re-generating. Provider failures never reach either write.
  if (previous) deps.write(`analysis/history/${date}-${analysisHash(previous)}`, previous);
  deps.write(`analysis/${date}`, report);
  return { status: "generated" as const, ...summary };
}
