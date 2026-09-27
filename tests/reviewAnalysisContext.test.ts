import { expect, it } from "vitest";
import { appendContextEvidence } from "@/lib/review/analysis/contextEvidence";
import { analysisHash } from "@/lib/review/analysis/fingerprint";
import { parseAnalysisEvidence } from "@/lib/review/analysis/model";
import { buildContextReport } from "@/lib/context/model";
import type { ContextObservation } from "@/lib/context/types";
import type { AnalysisEvidence } from "@/lib/review/analysis/types";

const date = "2026-09-25", cutoff = "2026-09-26T02:00:00.000Z", now = new Date("2026-09-26T03:00:00.000Z");
const evidence = (): AnalysisEvidence => ({ version: "analyst-evidence-v1", date, sourceBuiltAt: "2026-09-26T01:00:00.000Z", states: { market: "Neutral", macro: "Unknown", legacy: "Neutral" },
  coverage: (["market", "options", "sectors", "signals", "accounts", "journal", "tomorrow"] as const).map(section => ({ section, status: "partial", issues: [] })),
  facts: [{ id: "market.state", section: "market", label: "市场状态", value: "Neutral", unit: "", asOf: date, basis: "fixture", source: "review", status: "current", groups: ["daily-price"] }] });
function context() {
  const report = buildContextReport({ catalyst: null, flows: [], flowCoverage: { state: "partial", checkedAt: cutoff, detail: "部分样本" }, date, cutoff });
  const row: ContextObservation = { symbol: "AMD", state: "event-flow", stateLabel: "窗口内共现", summary: "RULE_PROSE_NOT_FACT", warnings: [],
    events: [{ id: "amd-event", title: "AMD 发布产品公告", type: "Product", sourceUrl: "https://example.com/amd", publishedAt: `${date}T14:00:00.000Z`, firstSeenAt: cutoff, updatedAt: cutoff, eventDate: date, anchorDate: date, timePrecision: "minute", importance: "high", revision: 1 }],
    flows: [{ id: "amd-flow", sourceUrl: null, postedAt: `${date}T15:00:00.000Z`, firstObservedAt: null, updatedAt: null, anchorDate: date, right: "call", side: "buyer", direction: "bull", premium: 100000, strike: 200, expiry: "2026-10-16", provenanceStatus: "legacy-unknown", revision: null, evidenceHash: null, flags: [] }],
    associations: [{ eventId: "amd-event", flowId: "amd-flow", sessionDistance: 0, window: "short" }],
    trend: { status: "observed", label: "MODEL_TREND_PROSE", signals: [], holdings: [], rps: { metric: "composite-daily-sp500-v1", value: 90, asOf: date, basis: "日线重建；非实时排名" } },
    timeline: [{ id: "event:amd-event", track: "event", at: `${date}T14:00:00.000Z`, observedAt: cutoff, title: "AMD 公告", timeBasis: "source", sourceUrl: "https://example.com/amd" }] };
  report.observations = [row]; report.highlights = [row];
  report.summary = { generatedAt: cutoff, model: "fixture", inputHash: "a".repeat(64), sentences: [{ text: "AI_TEXT_MUST_NOT_BE_REUSED", evidenceIds: ["event:amd-event"] }] };
  report.summaryStatus = "ready";
  return report;
}

it("adds bounded raw evidence with separate timestamps and partial coverage, without feeding AI text back", () => {
  const original = evidence();
  const result = parseAnalysisEvidence(appendContextEvidence(original, context(), now));
  const serialized = JSON.stringify(result);
  expect(serialized).toContain("AMD 发布产品公告");
  expect(serialized).toContain("legacy-unknown");
  expect(serialized).toContain("较晚的补充观察");
  expect(serialized).not.toMatch(/AI_TEXT_MUST_NOT_BE_REUSED|RULE_PROSE_NOT_FACT|MODEL_TREND_PROSE/);
  expect(result.facts.find(row => row.id === "context.AMD.flow.0")?.note).toContain("不是实际成交时间");
  expect(result.coverage.at(-1)?.status).toBe("partial");
  expect(original.facts).toHaveLength(1);
});

it("does not substitute other dates, future archives or malformed sources and exposes a citable inability to judge", () => {
  for (const raw of [null, { ...context(), asOf: "2026-09-24" }, { ...context(), generatedAt: "2026-09-27T00:00:00.000Z" }, { broken: true }]) {
    const result = appendContextEvidence(evidence(), raw, now);
    expect(result.coverage.at(-1)?.status).toBe("unavailable");
    expect(result.facts.at(-1)?.value).toContain("无法判断");
    expect(result.facts.some(row => row.id === "context.AMD.event.0")).toBe(false);
  }
});

it("AI prose edits do not invalidate facts, while raw evidence revisions do", () => {
  const first = context(), hash = analysisHash(appendContextEvidence(evidence(), first, now));
  const aiOnly = structuredClone(first); aiOnly.summary!.sentences[0].text = "OTHER_AI_TEXT";
  expect(analysisHash(appendContextEvidence(evidence(), aiOnly, now))).toBe(hash);
  const revision = structuredClone(first); revision.observations[0].events[0].title = "AMD 修订公告";
  revision.highlights = revision.observations;
  expect(analysisHash(appendContextEvidence(evidence(), revision, now))).not.toBe(hash);
});

it("normalizes valid microsecond relay timestamps at the analysis boundary while retaining the source value", () => {
  const raw = context();
  raw.observations[0].flows[0].postedAt = "2026-09-25T15:15:41.234000+00:00";
  raw.highlights = raw.observations;
  const packet = parseAnalysisEvidence(appendContextEvidence(evidence(), raw, now));
  const flow = packet.facts.find(row => row.id === "context.AMD.flow.0")!;
  expect(flow.asOf).toBe("2026-09-25T15:15:41.234Z");
  expect(String(flow.value)).toContain("2026-09-25T15:15:41.234000+00:00");
});
