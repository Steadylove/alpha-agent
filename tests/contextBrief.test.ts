import { describe, expect, it } from "vitest";
import { contextBriefOutcome, contextBriefTimeline, contextKnowledge, selectContextBrief } from "@/lib/context/brief";
import type { ContextObservation, ContextReport } from "@/lib/context/types";
import type { JournalSignal } from "@/lib/review/types";

const at = "2026-10-08T14:00:00Z", signalAt = "2026-10-08T15:00:00Z", cutoff = "2026-10-09T02:00:00Z";
function observation(symbol = "AMD"): ContextObservation {
  return { symbol, state: "insufficient", stateLabel: "证据覆盖不足", summary: "旧摘要",
    events: [{ id: "e", title: "Company reports quarterly results", type: "Earnings", sourceUrl: "https://example.com/news", publishedAt: at,
      firstSeenAt: at, updatedAt: at, eventDate: "2026-10-08", anchorDate: "2026-10-08", timePrecision: "minute", importance: "high", revision: 1 }],
    flows: [], associations: [], trend: { status: "observed", label: "", holdings: [], rps: null,
      signals: [{ id: "buy", tf: "2h", event: "buy", signalTime: signalAt, capturedAt: signalAt, eventLinks: [{ eventId: "e", knowledge: "known-at-signal" }], flowLinks: [] }] }, timeline: [], warnings: [] };
}
function report(rows = [observation()]): ContextReport {
  const partial = { state: "partial" as const, checkedAt: cutoff, detail: "部分样本" };
  return { version: 1, ruleVersion: "context-observation-v1", asOf: "2026-10-08", cutoff, generatedAt: cutoff, sampleLabel: "非完整市场样本，仅用于辅助观察",
    coverage: { events: partial, flow: partial, signals: partial }, observations: rows, highlights: rows.slice(0, 3), summary: null, summaryStatus: "not-requested", warnings: [] };
}
function addFlow(row: ContextObservation) {
  row.flows.push({ id: "f", postedAt: "2026-10-08T16:00:00Z", firstObservedAt: "2026-10-08T16:01:00Z", updatedAt: "2026-10-08T16:01:00Z",
    anchorDate: "2026-10-08", sourceUrl: "https://example.com/flow", right: "call", side: "buyer", direction: "bull", premium: 900000,
    strike: 100, expiry: "2026-11-20", provenanceStatus: "recorded", revision: 1, evidenceHash: "a".repeat(64), flags: [] });
  row.associations.push({ eventId: "e", flowId: "f", sessionDistance: 0, window: "short" });
  return row;
}

describe("Context homepage selection", () => {
  it("selects beyond old top three without mutating the archive", () => {
    const noise = ["AMD", "MRK", "GEV"].map(symbol => { const row = observation(symbol); row.events[0].title = "8 Of 11 Sectors Fall In Trading"; return row; });
    const value = report([...noise, addFlow(observation("NVDA"))]); const before = JSON.stringify(value);
    expect(selectContextBrief(value).map(item => item.observation.symbol)).toEqual(["NVDA"]);
    expect(JSON.stringify(value)).toBe(before);
  });
  it("does not mistake holdings, high RPS or unrelated signal days for an association", () => {
    const row = observation(); row.trend.signals = [];
    row.trend.holdings = [{ tf: "2h", asOf: "2026-10-08", observedAt: cutoff, label: "当前模型持仓快照" }];
    expect(selectContextBrief(report([row]))).toEqual([]);
    row.trend.signals = observation().trend.signals; row.trend.signals[0].signalTime = "2026-10-06T15:00:00Z";
    expect(selectContextBrief(report([row]))).toEqual([]);
  });
  it("excludes low-importance, market-wide, multi-company and round-up headlines", () => {
    for (const patch of [{ importance: "low" as const }, { type: "Industry" }, { scope: "market" as const }, { symbols: ["AMD", "MSFT", "META", "AAPL"] },
      { title: "Elon Musk Hypes Deal, but Cathie Wood Hits Sell on AMD" }, { title: "8 Industrials Stocks Whale Activity In Today's Session" }]) {
      const row = addFlow(observation()); Object.assign(row.events[0], patch);
      expect(selectContextBrief(report([row]))).toEqual([]);
    }
  });
  it("only uses the matching short-window flow and works without a signal", () => {
    const row = addFlow(observation()); row.trend.signals = [];
    expect(selectContextBrief(report([row]))[0].kind).toBe("event-flow");
    row.associations[0].window = "research"; row.associations[0].sessionDistance = 3;
    expect(selectContextBrief(report([row]))).toEqual([]);
    row.associations[0].window = "short"; row.associations[0].sessionDistance = 0; row.associations[0].flowId = "other";
    expect(selectContextBrief(report([row]))).toEqual([]);
  });
  it("ranks multiple evidence tracks before holding-only priority, bounds at three, and handles unavailable sources", () => {
    const value = report([observation("AMD"), observation("MSFT"), observation("AAPL"), addFlow(observation("NVDA"))]);
    expect(selectContextBrief(value)).toHaveLength(3); expect(selectContextBrief(value)[0].observation.symbol).toBe("NVDA");
    value.coverage.events = { state: "unavailable", checkedAt: null, detail: "缺失" };
    expect(selectContextBrief(value)).toEqual([]);
  });
});

describe("Context timing and follow-up", () => {
  it("uses version availability, not just publication or a stale knowledge label", () => {
    const value = report([addFlow(observation())]); let item = selectContextBrief(value)[0];
    expect(contextKnowledge(item, "event")).toBe("known-at-signal");
    expect(contextKnowledge(item, "flow")).toBe("observed-after-signal");
    expect(contextBriefTimeline(item).map(row => row.key)).toEqual(["event", "signal", "flow"]);
    value.observations[0].events[0].updatedAt = "2026-10-08T17:00:00Z"; item = selectContextBrief(value)[0];
    expect(contextKnowledge(item, "event")).toBe("observed-after-signal");
    value.observations[0].events[0].updatedAt = null;
    expect(contextKnowledge(item, "event")).toBe("unknown");
    value.observations[0].events[0].timePrecision = "date";
    expect(contextBriefTimeline(item).find(row => row.key === "event")!.at).toBeNull();
  });
  it("keeps future outcomes pending and never substitutes replay or another same-ticker buy", () => {
    const item = selectContextBrief(report())[0];
    const journal = { symbol: "AMD", tf: "2h", signalTime: Date.parse(signalAt), capturedAt: signalAt, source: "live",
      outcomes: { t1: { date: "2026-10-09", value: 5, status: "ready" }, t3: { date: null, value: null, status: "pending" }, t5: { date: null, value: null, status: "missing" } } } as JournalSignal;
    expect(contextBriefOutcome(item, [journal], "2026-10-08")?.t1).toMatchObject({ status: "pending", value: null });
    expect(contextBriefOutcome(item, [journal], "2026-10-09")?.t1.value).toBe(5);
    expect(contextBriefOutcome(item, [{ ...journal, source: "replay" }], "2026-10-09")).toBeNull();
    expect(contextBriefOutcome(item, [{ ...journal, signalTime: Date.parse(signalAt) - 1000 }], "2026-10-09")).toBeNull();
    item.signal!.event = "sell";
    expect(contextBriefOutcome(item, [journal], "2026-10-09")).toBeNull();
  });
});
