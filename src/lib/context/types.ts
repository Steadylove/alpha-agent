import type { CatalystReport } from "@/lib/catalyst/types";
import type { FlowEvent } from "@/lib/optionFlow/research/events";

export type ContextState = "event-flow" | "event-only" | "flow-only" | "insufficient" | "observing";
export type ContextCoverage = {
  state: "ok" | "partial" | "unavailable";
  checkedAt: string | null;
  /** Dates for which retrieval coverage was actually checked, not inferred from message presence. */
  from?: string;
  through?: string;
  detail: string;
};
export type ContextEventEvidence = {
  id: string; title: string; type: string; sourceUrl: string;
  publishedAt: string | null; firstSeenAt: string; updatedAt: string | null;
  eventDate: string; anchorDate: string | null; timePrecision: "minute" | "session" | "date" | "unknown";
  importance: "high" | "medium" | "low"; revision: number;
  /** Optional on older archives; copied from source metadata, never inferred. */
  scope?: "stock" | "sector" | "market";
  symbols?: string[];
};
export type ContextFlowEvidence = {
  id: string; sourceUrl: string | null; postedAt: string; firstObservedAt: string | null; updatedAt: string | null;
  anchorDate: string | null; right: "call" | "put"; side: "buyer" | "seller" | "unknown";
  direction: "bull" | "bear" | "unknown"; premium: number | null; strike: number | null; expiry: string | null;
  provenanceStatus: "recorded" | "legacy-unknown"; revision: number | null;
  evidenceHash: string | null; flags: string[];
};
export type ContextSignalEvidence = {
  id: string; tf: "2h" | "4h"; event: "buy" | "sell"; signalTime: string; capturedAt: string;
  eventLinks: { eventId: string; knowledge: "known-at-signal" | "observed-after-signal" | "unknown" }[];
  flowLinks: { flowId: string; knowledge: "known-at-signal" | "observed-after-signal" | "unknown" }[];
};
export type ContextHoldingEvidence = { tf: "2h" | "4h"; asOf: string; observedAt: string; label: "当前模型持仓快照" };
export type ContextRpsEvidence = {
  metric: "composite-daily-sp500-v1"; value: number; asOf: string; basis: "日线重建；非实时排名";
};
export type ContextTimelineItem = {
  id: string; track: "event" | "flow" | "trend"; at: string | null; observedAt: string | null;
  title: string; timeBasis: string; sourceUrl: string | null;
};
export type ContextObservation = {
  symbol: string; state: ContextState; stateLabel: string; summary: string;
  events: ContextEventEvidence[]; flows: ContextFlowEvidence[];
  associations: { eventId: string; flowId: string; sessionDistance: number; window: "short" | "research" }[];
  trend: {
    status: "observed" | "unknown";
    label: string;
    signals: ContextSignalEvidence[];
    holdings: ContextHoldingEvidence[];
    rps: ContextRpsEvidence | null;
  };
  timeline: ContextTimelineItem[];
  warnings: string[];
};
export type ContextSymbol = ContextObservation;
export type ContextSummary = { generatedAt: string; model: string; inputHash: string; sentences: { text: string; evidenceIds: string[] }[] };
export type ContextReport = {
  version: 1; ruleVersion: "context-observation-v1"; asOf: string; cutoff: string; generatedAt: string;
  revision?: number;
  originalCapturedAt?: string;
  supersedesCutoff?: string;
  sampleLabel: "非完整市场样本，仅用于辅助观察";
  coverage: { events: ContextCoverage; flow: ContextCoverage; signals: ContextCoverage };
  observations: ContextObservation[];
  highlights: ContextObservation[];
  summary: ContextSummary | null;
  summaryStatus: "ready" | "stale" | "unavailable" | "not-requested";
  warnings: string[];
};
export type ContextModelInput = {
  catalyst: CatalystReport | null;
  flows: readonly FlowEvent[];
  flowCoverage: ContextCoverage;
  date: string;
  cutoff: string;
  /** Defaults to the observation cutoff; a later build cannot add later-known evidence. */
  generatedAt?: string;
};
