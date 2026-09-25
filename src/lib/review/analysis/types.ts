/** Client-safe DTOs; no provider credentials or strategy internals belong here. */
export const ANALYSIS_VERSION = "daily-analyst-v1" as const;
export const EVIDENCE_VERSION = "analyst-evidence-v1" as const;
export type AnalysisSection = "market" | "options" | "sectors" | "signals" | "accounts" | "journal" | "tomorrow";
export type AnalysisFact = {
  id: string;
  section: AnalysisSection;
  label: string;
  value: number | string | boolean | null;
  unit: string;
  asOf: string | null;
  basis: string;
  status: "current" | "delayed" | "stale" | "missing" | "unknown";
  source: string;
  groups: string[];
  note?: string;
};
export type AnalysisEvidence = {
  version: typeof EVIDENCE_VERSION;
  date: string;
  sourceBuiltAt: string;
  states: { market: string; legacy: string; macro: string };
  coverage: { section: AnalysisSection; status: "available" | "partial" | "unavailable"; issues: string[] }[];
  facts: AnalysisFact[];
};
export type AnalysisClaim = { text: string; factIds: string[] };
export type AnalysisOutput = {
  lead: AnalysisClaim;
  changes: AnalysisClaim[];
  divergences: AnalysisClaim[];
  confirmations: AnalysisClaim[];
  context: AnalysisClaim[];
  focus: AnalysisClaim[];
  limitations: AnalysisClaim[];
};
export type AnalysisReport = {
  version: typeof ANALYSIS_VERSION;
  date: string;
  generatedAt: string;
  sourceBuiltAt: string;
  sourceHash: string;
  inputHash: string;
  promptVersion: string;
  model: string;
  evidence: AnalysisEvidence;
  output: AnalysisOutput;
  usage: { promptTokens: number; completionTokens: number } | null;
};
export type AnalysisView = {
  report: AnalysisReport | null;
  status: "ready" | "stale" | "missing" | "unavailable";
};
