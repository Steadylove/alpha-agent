import { createHash } from "node:crypto";
import type { DailyReview, JournalArchive } from "../types";
import { buildAnalysisEvidence } from "./evidence";
import { journalAsOf } from "../journal";
import { parseAnalysisEvidence } from "./model";

/** Stable across JSON serialization and property insertion order. */
export function analysisHash(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)]));
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function isAnalysisDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
}

export function prepareAnalysisInput(review: DailyReview, journal: JournalArchive | null) {
  const archiveValid = journal?.version === 1 && Array.isArray(journal.signals);
  // Later archive growth is not a revision of this day's evidence. Cut before computing counts/hashes.
  const records = journalAsOf(archiveValid ? journal.signals : review.signals, review.date)
    .filter((s) => Date.parse(s.capturedAt) <= Date.parse(review.builtAt));
  const evidence = buildAnalysisEvidence(review, records);
  const archiveCurrent = archiveValid && journal.asOf >= review.date;
  evidence.facts.push({
    id: "journal.archive", section: "journal", label: "信号跟踪档案覆盖",
    value: archiveCurrent ? "档案已覆盖所选日期，结果按该日截断" : "档案缺失或未覆盖所选日期，仅使用已有记录",
    unit: "说明", asOf: archiveCurrent ? review.date : archiveValid ? journal.asOf : null, basis: "archive-coverage",
    status: archiveCurrent ? "current" : "missing", source: "JournalArchive.asOf",
    groups: ["journal-outcome"],
  });
  if (!archiveCurrent) {
    const coverage = evidence.coverage.find((c) => c.section === "journal");
    if (coverage) {
      if (coverage.status === "available") coverage.status = "partial";
      coverage.issues.push("信号跟踪档案缺失或未覆盖所选日期，不代表完整历史样本。");
    }
  }
  const checked = parseAnalysisEvidence(evidence);
  return { evidence: checked, sourceHash: analysisHash(review), inputHash: analysisHash(checked) };
}
