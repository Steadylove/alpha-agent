import { describe, expect, it } from "vitest";
import { normalizeFlowEvents } from "@/lib/optionFlow/research/events";
import { flowSide, flowLean } from "@/lib/optionFlow/direction";
import { buildFlowResearch, flowOutcomes, researchRps, type ResearchInputs } from "@/lib/optionFlow/research/model";
import { flowResearchSymbols } from "@/lib/optionFlow/research/universe";
import type { OptionFlowPost } from "@/lib/optionFlow/types";
import type { PanelBars } from "@/lib/backtest/panel";

const sessions = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23"];
const post = (id: string, date = sessions[0], extra: Partial<OptionFlowPost> = {}): OptionFlowPost => ({
  id, tweetId: id, postedAt: `${date}T15:30:00Z`, ingestedAt: `${date}T15:30:01Z`, handle: "FL0WG0D", kind: "flow",
  thesis: "$AAA Call buyer", rawText: "$AAA Call buyer", imageUrls: [], imageProxyUrls: [],
  legs: [{ ticker: "AAA", right: "call", premiumUsd: 1000, strike: 100, expiry: "10/16/26" }], ...extra,
});
function panel(ticker = "AAA"): PanelBars {
  return { ticker, dates: [...sessions], open: Float32Array.from(sessions.map(() => 100)), close: Float32Array.from(sessions.map((_, i) => 100 + i)),
    high: Float32Array.from(sessions.map((_, i) => 101 + i)), low: Float32Array.from(sessions.map(() => 99)), volume: new Float32Array(sessions.length) };
}
function input(posts: OptionFlowPost[] = [post("1")]): ResearchInputs {
  return { flow: { updatedAt: "2026-09-23T22:00:00Z", channelId: "test", lastMessageId: "1", posts }, rps: null, scale: null,
    sessions, panels: new Map([["AAA", panel()], ["SPY", panel("SPY")]]), warnings: [] };
}
describe("flow research source integrity", () => {
  it("unknown and conflicting sides remain unclassified", () => {
    expect(flowSide("$10M into these calls")).toBe("unknown");
    expect(flowSide("call buyer and put seller")).toBe("unknown");
    expect(flowLean("call", "unknown")).toBeUndefined();
    expect(flowLean("put", "seller")).toBe("bull");
  });
  it("deduplicates original source IDs across relay channels but keeps separate trades", () => {
    const out = normalizeFlowEvents([post("a"), post("copy", sessions[1], { tweetId: "a" }), post("b")], sessions);
    expect(out.events).toHaveLength(2);
    expect(out.events[0].sourceIds).toHaveLength(2);
    expect(out.events.every(e => e.day === sessions[0])).toBe(true);
  });
  it("recaps, OI confirmations, non-source messages and non-sessions are excluded", () => {
    const out = normalizeFlowEvents([post("a"), post("recap", sessions[1], { kind: "noteworthy" }), post("oi", sessions[1], { rawText: "OI confirmed" }), post("sat", "2026-09-12"), post("other", sessions[0], { handle: "other" })], sessions);
    expect(out.events).toHaveLength(1);
    expect(out.excluded[sessions[1]]).toBe(2);
  });
  it("never merges similar premiums across expiries or guesses an exact expiry", () => {
    const out = normalizeFlowEvents([post("a"), post("b", sessions[0], { legs: [{ ticker: "AAA", right: "call", premiumUsd: 990, strike: 100, expiry: "December" }] })], sessions);
    expect(out.events).toHaveLength(2);
    expect(out.events.map(e => e.expiry)).toContain("December");
  });
  it("ambiguous multi-leg amounts are not counted twice or assigned a global side", () => {
    const p = post("multi", sessions[0], { legs: [{ ticker: "AAA", right: "call", premiumUsd: 1000 }, { ticker: "BBB", right: "put", premiumUsd: 1000 }] });
    const result = buildFlowResearch(input([p]), sessions[0]);
    expect(result.totals.premium).toBe(0);
    expect(result.totals.priced).toBe(0);
    expect(result.events.every(e => e.side === "unknown")).toBe(true);
  });
  it("theme totals reconcile with ticker totals and unknowns remain in the denominator", () => {
    const result = buildFlowResearch(input([post("a"), post("b", sessions[0], { rawText: "calls", legs: [{ ticker: "NVDA", right: "call", premiumUsd: 3000 }] })]), sessions[0]);
    expect(result.totals.premium).toBe(4000);
    expect(result.totals.unknown).toBe(3000);
    expect(result.themes.reduce((n, t) => n + t.premium, 0)).toBe(4000);
    expect(result.totals.top3).toBe(100);
  });
  it("persistence counts trading days, not messages; no future records leak", () => {
    const inputs = input([post("a", sessions[2]), post("b", sessions[3]), post("c", sessions[4]), post("d", sessions[4]), post("future", sessions[5])]);
    const report = buildFlowResearch(inputs, sessions[4]);
    expect(report.profiles[0]).toMatchObject({ days5: 3, consecutive: 3, persistence: "持续出现" });
    expect(report.totals.records).toBe(2);
    expect(report.coverage.observed5).toBe(3);
    expect(report.warnings.join(" ")).toContain("无法确认采集完整");
  });
  it("RPS does not backfill history using the latest ranking; ETFs stay separate", () => {
    const inputs = input([post("etf", sessions[0], { legs: [{ ticker: "QQQ", right: "call" }] })]);
    inputs.rps = { generatedAt: "2026-09-23T22:00:00Z", poolId: "test", benchmark: "SP500", sourceTimeframe: "1d", timeframes: { "1d": { AAA: { rps: 99, asOf: sessions[10] } } } };
    expect(researchRps(inputs, "AAA", sessions[0])).toBeNull();
    expect(researchRps(inputs, "AAA", sessions[10])).toBe(99);
    expect(buildFlowResearch(inputs, sessions[0]).profiles[0]).toMatchObject({ rps: null, strength: "ETF / 指数" });
  });
});
describe("flow follow-through", () => {
  it("uses next open, exact sessions and known data through asOf", () => {
    const inputs = input(); const report = buildFlowResearch(inputs, sessions[0]);
    const early = flowOutcomes([report], inputs, sessions[1])[0];
    expect(early).toMatchObject({ entryDate: sessions[1], entry: 100, t1: 1, t5: null, t10: null, mfe: null });
    const mature = flowOutcomes([report], inputs, sessions[10])[0];
    expect(mature).toMatchObject({ t5: 5, t10: 10, excess5: 0, mfe: 11, mae: -1 });
  });
  it("missing bars do not shift the T+5 endpoint or fabricate an entry", () => {
    const inputs = input(); const report = buildFlowResearch(inputs, sessions[0]);
    inputs.panels.get("AAA")!.dates[3] = "2020-01-01";
    expect(flowOutcomes([report], inputs, sessions[10])[0].t5).toBeNull();
    inputs.panels.get("AAA")!.open = null;
    expect(flowOutcomes([report], inputs, sessions[10])[0].entry).toBeNull();
  });
  it("research tickers are limited to source option records and recent dates", () => {
    expect(flowResearchSymbols([post("a"), post("old", "2025-01-01"), post("bad", sessions[0], { legs: [{ ticker: "../secret", right: "put" }] })], sessions[10])).toEqual(["AAA"]);
  });
});
