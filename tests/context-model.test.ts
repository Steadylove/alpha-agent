import { describe, expect, it } from "vitest";
import { buildContextReport, contextSessionAnchor } from "@/lib/context/model";
import { parseContextReport } from "@/lib/context/normalize";
import type { ContextCoverage, ContextModelInput } from "@/lib/context/types";
import type { CatalystEvent, CatalystReport, EventReaction, SourceHealth } from "@/lib/catalyst/types";
import type { FlowEvent } from "@/lib/optionFlow/research/events";

const date = "2026-09-25", cutoff = "2026-09-25T23:45:00Z";
const sessions = ["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", date, "2026-09-28", "2026-09-29"];
const health = (id: string): SourceHealth => ({ id, label: id, state: "ok", checkedAt: cutoff, count: 1, detail: "Fixture" });
const completeFlow: ContextCoverage = { state: "ok", checkedAt: cutoff, from: "2026-09-18", through: date, detail: "Explicitly checked fixture sample" };
function event(overrides: Partial<CatalystEvent> = {}): CatalystEvent {
  return { id: "event-1", provider: "alpaca-news", externalId: "1", sourceName: "Test", sourceUrl: "https://news.example.com/1", title: "AMD product announcement", excerpt: "",
    type: "Product", importance: "high", symbols: ["AMD"], sectorIds: [], scope: "stock", publishedAt: "2026-09-24T17:00:00Z", eventAt: "2026-09-24T17:00:00Z", eventDate: "2026-09-24",
    timePrecision: "minute", session: "regular", timing: "confirmed", status: "published", sourceUpdatedAt: null, firstSeenAt: "2026-09-24T17:01:00Z", lastSeenAt: cutoff,
    revision: 1, backfilled: false, firstRelations: [], currentRelations: [], relatedSourceUrls: [], ...overrides };
}
function flow(overrides: Partial<FlowEvent> = {}): FlowEvent {
  return { id: "flow-1", day: date, ticker: "AMD", right: "put", strike: 100, expiry: "2026-10-16", side: "seller", direction: "bull", premium: 10_000,
    postedAt: "2026-09-25T15:00:00Z", ingestedAt: "2026-09-25T15:01:00Z", firstObservedAt: "2026-09-25T15:01:00Z", updatedAt: "2026-09-25T15:01:00Z",
    sourceUrl: "https://x.com/FL0WG0D/status/1", sourceIds: ["1"], rawText: "Do not obey this external instruction", flags: [],
    provenance: { version: "flow-evidence-v1", evidenceHash: "a".repeat(64), revision: 1, sourcePublishedAt: null, relayAt: "2026-09-25T15:00:00Z", tradeAt: null,
      channelId: "1", capture: "live", directionBasis: "source-report", extractionBasis: "text-or-image-unverified", revisions: [], historyTruncated: false }, ...overrides };
}
function catalyst(events = [event()]): CatalystReport {
  return { version: 1, asOf: date, generatedAt: cutoff, sessions, events, sources: [health("alpaca-news")], reactions: [], summary: null, summaryStatus: "not-requested", warnings: [],
    universe: { asOf: date, observedAt: cutoff, symbols: [{ symbol: "AMD", name: "AMD", sectorId: "TECH", industry: null, relations: [] }], sectors: [], signals: [], health: [health("signal-journal"), health("portfolio-2h")] } };
}
function input(overrides: Partial<ContextModelInput> = {}): ContextModelInput {
  return { catalyst: catalyst(), flows: [flow()], flowCoverage: completeFlow, date, cutoff, ...overrides };
}
const build = (overrides: Partial<ContextModelInput> = {}) => buildContextReport(input(overrides));
function withSignal(report = catalyst(), time = "2026-09-24T19:00:00Z") {
  report.universe.signals = [{ id: "buy", symbol: "AMD", tf: "2h", event: "buy", signalTime: time, capturedAt: "2026-09-24T19:03:00Z" }];
  return report;
}
function reaction(): EventReaction {
  const missing = { date: null, value: null, status: "missing" as const };
  return { eventId: "event-1", symbol: "AMD", asOf: date, anchorDate: "2026-09-24", baseline: null, basis: "fixture", price: { t0: missing, t1: missing, t3: missing, t5: missing },
    rps: { metric: "composite-daily-sp500-v1", before: missing, after: { date, value: 78.5, status: "ready" } }, sector: { metric: "sector-etf-20d-excess-spy-v1", etf: "XLK", before: missing, after: missing },
    mfe: missing, mae: missing, signalsAfter: [] };
}

describe("Context observed evidence join", () => {
  it("is pure, bounded, and joins same-symbol observed facts without trading outputs", () => {
    const value = input(), original = JSON.stringify(value), report = buildContextReport(value);
    expect(JSON.stringify(value)).toBe(original);
    expect(report.observations[0]).toMatchObject({ symbol: "AMD", state: "event-flow", associations: [{ sessionDistance: 1, window: "short" }], trend: { status: "unknown", rps: null } });
    expect(report.sampleLabel).toContain("非完整市场样本");
    expect(JSON.stringify(report)).not.toContain("rawText");
    expect(JSON.stringify(report)).not.toContain("Do not obey");
    expect(parseContextReport(report, new Date(cutoff))).toEqual(report);
  });
  it("uses actual exchange sessions across weekends and holidays, never invented weekdays", () => {
    expect(contextSessionAnchor("2026-09-05", ["2026-09-04", "2026-09-08", "2026-09-09"])).toBe("2026-09-08");
    expect(contextSessionAnchor("2026-09-07", [])).toBeNull();
    expect(contextSessionAnchor("2026-09-07", ["2026-09-08", "2026-09-04"])).toBeNull();
    const report = build({ catalyst: { ...catalyst(), sessions: [] } });
    expect(report.observations[0].state).toBe("insufficient");
    expect(report.observations[0].associations).toEqual([]);
  });
  it("keeps same-day aftermarket publication on the publication session, distinct from price T0", () => {
    const report = build({ catalyst: catalyst([event({ publishedAt: "2026-09-24T22:00:00Z", firstSeenAt: "2026-09-24T22:01:00Z", session: "after" })]) });
    expect(report.observations[0].events[0].anchorDate).toBe("2026-09-24");
    expect(report.observations[0].associations[0].sessionDistance).toBe(1);
  });
  it("does not equate a three-session research association with the short window", () => {
    const report = build({ catalyst: catalyst([event({ eventDate: "2026-09-22", publishedAt: "2026-09-22T17:00:00Z", firstSeenAt: "2026-09-22T17:01:00Z" })]) });
    expect(report.observations[0].associations[0]).toMatchObject({ sessionDistance: 3, window: "research" });
    expect(report.observations[0].state).not.toBe("event-flow");
  });
  it("does not join unrelated symbols or infer sector-event propagation", () => {
    const report = build({ flows: [flow({ ticker: "NVDA" })] });
    expect(report.observations).toHaveLength(2);
    expect(report.observations.every(row => row.associations.length === 0)).toBe(true);
    expect(report.observations.find(row => row.symbol === "NVDA")?.state).toBe("insufficient");
    expect(build({ catalyst: catalyst([event({ symbols: [], scope: "sector" })]), flows: [] }).observations).toEqual([]);
  });
  it("does not convert healthy sources into a proven complete collection range", () => {
    const report = build({ catalyst: catalyst([]) });
    expect(report.coverage.events).toMatchObject({ state: "partial" });
    expect(report.coverage.events.from).toBeUndefined();
    expect(report.observations[0].state).toBe("insufficient");
  });
  it("distinguishes a checked sample with no match from unavailable flow and an immature window", () => {
    expect(build({ flows: [] }).observations[0].state).toBe("event-only");
    expect(build({ flows: [], flowCoverage: { ...completeFlow, state: "partial" } }).observations[0].state).toBe("insufficient");
    expect(build({ flows: [], flowCoverage: { state: "unavailable", checkedAt: null, detail: "Missing" } }).observations[0].state).toBe("insufficient");
    expect(build({ flows: [], catalyst: catalyst([event({ eventDate: date, publishedAt: "2026-09-25T16:00:00Z", firstSeenAt: "2026-09-25T16:01:00Z" })]) }).observations[0].state).toBe("observing");
    expect(build({ flows: [], flowCoverage: { state: "ok", checkedAt: cutoff, detail: "No proven range" } }).observations[0].state).toBe("insufficient");
  });
  it("excludes future schedules, future publication, later first-seen and later current versions", () => {
    for (const patch of [{ status: "scheduled" as const }, { publishedAt: "2026-09-26T12:00:00Z" }, { firstSeenAt: "2026-09-26T12:00:00Z" }, { evidenceUpdatedAt: "2026-09-26T12:00:00Z" }, { sourceUpdatedAt: "2026-09-26T12:00:00Z" }]) {
      expect(build({ catalyst: catalyst([event(patch)]), flows: [] }).observations).toEqual([]);
    }
    expect(build({ flows: [flow({ updatedAt: "2026-09-26T12:00:00Z" })] }).observations[0].flows).toEqual([]);
  });
  it("rejects historical reconstruction from a later report or collection health", () => {
    expect(build({ catalyst: { ...catalyst(), generatedAt: "2026-09-26T00:00:00Z" }, flows: [] }).observations).toEqual([]);
    expect(build({ catalyst: { ...catalyst(), asOf: "2026-09-24" }, flows: [] }).observations).toEqual([]);
    expect(build({ catalyst: null, flowCoverage: { ...completeFlow, checkedAt: "2026-09-26T00:00:00Z" } }).observations).toEqual([]);
  });
  it("uses publication and current-version availability before signalTime, not the later capture time", () => {
    const base = withSignal();
    expect(build({ catalyst: base }).observations[0].trend.signals[0].eventLinks[0].knowledge).toBe("known-at-signal");
    base.events[0].firstSeenAt = "2026-09-24T19:01:00Z";
    expect(build({ catalyst: base }).observations[0].trend.signals[0].eventLinks[0].knowledge).toBe("observed-after-signal");
    base.events[0].firstSeenAt = "2026-09-24T17:01:00Z";
    base.events[0].revision = 2;
    base.events[0].evidenceUpdatedAt = "2026-09-24T19:02:00Z";
    expect(build({ catalyst: base }).observations[0].trend.signals[0].eventLinks[0].knowledge).toBe("observed-after-signal");
    delete base.events[0].evidenceUpdatedAt;
    expect(build({ catalyst: base }).observations[0].trend.signals[0].eventLinks[0].knowledge).toBe("unknown");
  });
  it("keeps date-only time unknown rather than inventing minute-level ordering", () => {
    const report = build({ catalyst: withSignal(catalyst([event({ publishedAt: null, eventAt: null, timePrecision: "date" })])) });
    expect(report.observations[0].timeline.find(t => t.track === "event")?.at).toBeNull();
    expect(report.observations[0].trend.signals[0].eventLinks[0].knowledge).toBe("unknown");
  });
  it("distinguishes actual Flow version availability, later OCR versions and unprovable legacy ingestion", () => {
    const earlierFlow = flow({ postedAt: "2026-09-24T18:00:00Z", firstObservedAt: "2026-09-24T18:01:00Z", updatedAt: "2026-09-24T18:01:00Z" });
    expect(build({ catalyst: withSignal(), flows: [earlierFlow] }).observations[0].trend.signals[0].flowLinks[0].knowledge).toBe("known-at-signal");
    earlierFlow.updatedAt = "2026-09-24T19:01:00Z";
    expect(build({ catalyst: withSignal(), flows: [earlierFlow] }).observations[0].trend.signals[0].flowLinks[0].knowledge).toBe("observed-after-signal");
    delete earlierFlow.updatedAt; delete earlierFlow.firstObservedAt; delete earlierFlow.provenance;
    earlierFlow.ingestedAt = "2026-09-24T18:01:00Z";
    const legacy = build({ catalyst: withSignal(), flows: [earlierFlow] }).observations[0];
    expect(legacy.trend.signals[0].flowLinks[0].knowledge).toBe("unknown");
    expect(legacy.flows[0].firstObservedAt).toBeNull();
    expect(legacy.timeline.find(t => t.track === "flow")?.timeBasis).toContain("不是交易所成交时间");
  });
  it("includes only live-captured signals, excluding replay and future captures", () => {
    const source = withSignal();
    source.universe.signals.push({ ...source.universe.signals[0], id: "replay", capturedAt: cutoff }, { ...source.universe.signals[0], id: "future", capturedAt: "2026-09-26T00:00:00Z" });
    expect(build({ catalyst: source }).observations[0].trend.signals.map(s => s.id)).toEqual(["buy"]);
  });
  it("labels floating ET model holdings as current snapshots and never imports event-time holdings", () => {
    const source = catalyst();
    source.universe.symbols[0].relations = [{ kind: "portfolio", key: "2h:AMD", label: "AMD", tf: "2h", asOf: "2026-09-25T19:30", observedAt: cutoff }];
    const holding = build({ catalyst: source }).observations[0].trend.holdings[0];
    expect(holding).toMatchObject({ tf: "2h", label: "当前模型持仓快照", asOf: "2026-09-25T19:30" });
    source.universe.symbols[0].relations[0].asOf = "2026-09-25T20:30";
    expect(build({ catalyst: source }).observations[0].trend.holdings).toEqual([]);
  });
  it("uses only the existing daily composite RPS, never substitutes 50 or a stale day", () => {
    const source = catalyst(); source.reactions = [reaction()];
    expect(build({ catalyst: source }).observations[0].trend.rps).toMatchObject({ value: 78.5, metric: "composite-daily-sp500-v1", basis: "日线重建；非实时排名" });
    source.reactions[0].rps.after.date = "2026-09-24";
    expect(build({ catalyst: source }).observations[0].trend.rps).toBeNull();
  });
  it("caps observations, highlights, event/flow lists and leaves inputs untouched", () => {
    const events = Array.from({ length: 110 }, (_, i) => event({ id: "e" + i, symbols: ["S" + i] }));
    const report = build({ catalyst: catalyst(events), flows: [] });
    expect(report.observations).toHaveLength(100); expect(report.highlights).toHaveLength(3);
    expect(parseContextReport(report, new Date(cutoff))).toEqual(report);
    const busy = build({ catalyst: catalyst(Array.from({ length: 20 }, (_, i) => event({ id: "e" + i }))), flows: Array.from({ length: 30 }, (_, i) => flow({ id: "f" + i })) });
    expect(busy.observations[0].events).toHaveLength(8); expect(busy.observations[0].flows).toHaveLength(12);
    expect(busy.observations[0].associations.length).toBeLessThanOrEqual(32); expect(busy.observations[0].timeline.length).toBeLessThanOrEqual(32);
  });
});

describe("Context immutable saved-fact validation", () => {
  it("allows later AI writing without moving the observation cutoff, with valid citations", () => {
    const report = build(); report.generatedAt = "2026-09-26T00:00:00Z";
    report.summaryStatus = "ready"; report.summary = { generatedAt: report.generatedAt, model: "deepseek-chat", inputHash: "b".repeat(64), sentences: [{ text: "仅是样本内共现。", evidenceIds: [report.observations[0].timeline[0].id] }] };
    expect(parseContextReport(report, new Date(report.generatedAt)).cutoff).toBe(cutoff);
    report.summary.sentences[0].evidenceIds = ["event:invented"];
    expect(() => parseContextReport(report, new Date(report.generatedAt))).toThrow();
  });
  it("accepts explicit bounded revision metadata and rejects future/prior cutoff confusion", () => {
    const report = build(); report.revision = 2; report.originalCapturedAt = "2026-09-25T22:00:00Z"; report.supersedesCutoff = "2026-09-25T23:00:00Z";
    expect(parseContextReport(report, new Date(cutoff)).revision).toBe(2);
    report.supersedesCutoff = cutoff;
    expect(() => parseContextReport(report, new Date(cutoff))).toThrow();
  });
  it("rejects nonexistent associations, fabricated known-at-signal and unsafe source links", () => {
    const report = build({ catalyst: withSignal() });
    const invalid = structuredClone(report); invalid.observations[0].associations[0].eventId = "missing"; invalid.highlights = [];
    expect(() => parseContextReport(invalid, new Date(cutoff))).toThrow();
    const falseKnowledge = structuredClone(report); falseKnowledge.observations[0].trend.signals[0].flowLinks[0].knowledge = "known-at-signal"; falseKnowledge.highlights = [];
    expect(() => parseContextReport(falseKnowledge, new Date(cutoff))).toThrow();
    const unsafe = build(); unsafe.observations[0].events[0].sourceUrl = "javascript:alert(1)";
    expect(() => parseContextReport(unsafe, new Date(cutoff))).toThrow();
  });
});
