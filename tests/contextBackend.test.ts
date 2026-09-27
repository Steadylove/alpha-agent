import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CatalystReport, EventInput } from "@/lib/catalyst/types";
import { mergeCatalystEvents } from "@/lib/catalyst/normalize";
import { buildContextReport } from "@/lib/context/model";
import { contextEvidenceHash, analyzeContext, generateContextSummary } from "@/lib/context/summary";
import { publishContextReport, saveContextReport } from "@/lib/context/publish";
import { getContextReport } from "@/lib/context/store";
import { parseContextReport } from "@/lib/context/normalize";
import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { snapshotDir, snapshotFile, writeSnapshot } from "@/lib/vps/snapshot";
import type { FlowEvent } from "@/lib/optionFlow/research/events";

vi.mock("@/lib/backtest/marketRemote", () => ({ fetchMarketText: vi.fn() }));
const date = "2026-09-25", stamp = "2026-09-26T02:00:00.000Z", now = new Date(stamp);
let directory: string;
const eventInput = (): EventInput => ({ provider: "test-news", externalId: "amd", sourceName: "Fixture", sourceUrl: "https://example.com/amd", title: "AMD 发布产品说明", excerpt: "公告资料", type: "Product", importance: "high", symbols: ["AMD"], sectorIds: [], scope: "stock", publishedAt: "2026-09-25T14:00:00.000Z", eventAt: null, eventDate: date, timePrecision: "minute", session: "regular", timing: "confirmed", status: "published", sourceUpdatedAt: null });
function catalyst(at = stamp): CatalystReport {
  const report: CatalystReport = { version: 1, asOf: date, generatedAt: at, sessions: ["2026-09-22", "2026-09-23", "2026-09-24", date, "2026-09-28", "2026-09-29"],
    universe: { asOf: date, observedAt: at, symbols: [{ symbol: "AMD", name: "AMD", sectorId: null, industry: null, relations: [{ kind: "opportunity", key: "AMD", label: "AMD", asOf: date, observedAt: at }] }], sectors: [], signals: [], health: [] },
    sources: [{ id: "test-news", label: "Fixture", state: "ok", checkedAt: at, count: 1, detail: "sample" }], events: [], reactions: [], summary: null, summaryStatus: "not-requested", warnings: [] };
  report.events = mergeCatalystEvents([], [eventInput()], report.universe, new Date(at)).events;
  return report;
}
const emptyFlows = () => ({ flows: [], coverage: { state: "unavailable" as const, checkedAt: null, detail: "missing" } });
function context() { return buildContextReport({ catalyst: catalyst(), ...{ flows: [], flowCoverage: emptyFlows().coverage }, date, cutoff: stamp }); }
const generate = vi.fn<typeof generateContextSummary>(async (report, options) => ({ generatedAt: options.now.toISOString(), inputHash: contextEvidenceHash(report), model: options.model,
  sentences: [{ text: "AMD 已有产品报道，当前期权流覆盖不足。", evidenceIds: [report.highlights[0].timeline[0].id] }] }));

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "context-backend-"));
  vi.stubEnv("MARKET_DATA_DIR", directory); vi.stubEnv("MARKET_DATA_BASE_URL", ""); vi.stubEnv("VERCEL", "");
  vi.mocked(fetchMarketText).mockReset(); generate.mockClear();
  writeSnapshot(`daily-review/${date}`, { version: 1, date, builtAt: "2026-09-26T01:00:00.000Z" });
  writeSnapshot("daily-review/index", { version: 1, latest: date });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

describe("Context publication and historical separation", () => {
  it("saves separate context, freezes facts by default, refreshes with exact-byte archival", async () => {
    const original = readFileSync(snapshotFile(`daily-review/${date}`));
    const first = await publishContextReport(catalyst(), { now, loadFlows: emptyFlows });
    expect(first.status).toBe("saved");
    const file = snapshotFile(`context/${date}`), bytes = readFileSync(file);
    const next = catalyst("2026-09-26T03:00:00.000Z"); next.events[0].title = "新的说明";
    await publishContextReport(next, { now: new Date(next.generatedAt), loadFlows: emptyFlows });
    expect(readFileSync(file)).toEqual(bytes);
    await publishContextReport(next, { now: new Date(next.generatedAt), refresh: true, loadFlows: emptyFlows });
    const folder = path.join(snapshotDir(), "context/history", date);
    expect(readdirSync(folder).some(name => readFileSync(path.join(folder, name)).equals(bytes))).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).revision).toBe(2);
    expect(readFileSync(snapshotFile(`daily-review/${date}`))).toEqual(original);
  });
  it("adds AI to a frozen cutoff and reuses identical evidence without another model call", async () => {
    await publishContextReport(catalyst(), { now, loadFlows: emptyFlows });
    const later = new Date("2026-09-26T03:00:00.000Z");
    await publishContextReport(catalyst(later.toISOString()), { now: later, analyze: true, apiKey: "fixture-key", generate, loadFlows: emptyFlows });
    const saved = JSON.parse(readFileSync(snapshotFile(`context/${date}`), "utf8"));
    expect(saved.cutoff).toBe(stamp); expect(saved.summaryStatus).toBe("ready"); expect(generate).toHaveBeenCalledTimes(1);
    await publishContextReport(catalyst(later.toISOString()), { now: later, analyze: true, apiKey: "fixture-key", generate, loadFlows: emptyFlows });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("preserves dated Flow evidence when only the Flow source becomes unavailable", async () => {
    const flow: FlowEvent = { id: "flow-fixture", day: date, ticker: "AMD", right: "call", strike: 200, expiry: "2026-10-16", side: "buyer", direction: "bull", premium: 500000,
      postedAt: "2026-09-25T14:00:00.000Z", ingestedAt: stamp, sourceUrl: "https://x.com/FL0WG0D/status/123", sourceIds: ["123"], rawText: "source report", flags: [] };
    const loadFlows = () => ({ flows: [flow], coverage: { state: "partial" as const, checkedAt: stamp, detail: "partial sample" } });
    await publishContextReport(catalyst(), { now, loadFlows });
    const file = snapshotFile(`context/${date}`), before = readFileSync(file);
    await publishContextReport(catalyst("2026-09-26T03:00:00.000Z"), { now: new Date("2026-09-26T03:00:00.000Z"), refresh: true, loadFlows: emptyFlows });
    expect(readFileSync(file)).toEqual(before);
    expect(JSON.parse(readFileSync(snapshotFile("context/latest"), "utf8")).coverage.flow.state).toBe("unavailable");
  });
  it("does not create historical date reports after the review index moves forward", async () => {
    writeSnapshot("daily-review/index", { version: 1, latest: "2026-09-28" });
    expect((await publishContextReport(catalyst(), { now, refresh: true, loadFlows: emptyFlows })).status).toBe("waiting");
    expect(existsSync(snapshotFile(`context/${date}`))).toBe(false);
  });
  it("preserves corrupt historical archives and reports failure", async () => {
    saveContextReport(context());
    writeFileSync(snapshotFile(`context/${date}`), "corrupt");
    expect((await publishContextReport(catalyst(), { now, refresh: true, loadFlows: emptyFlows })).status).toBe("unavailable");
    expect(readFileSync(snapshotFile(`context/${date}`), "utf8")).toBe("corrupt");
  });
  it("never substitutes latest or local files for a missing remote historical date", async () => {
    saveContextReport(context()); saveContextReport(context(), snapshotDir(), "latest");
    expect(await getContextReport("2026-09-24")).toBeNull();
    vi.stubEnv("MARKET_DATA_BASE_URL", "https://market.example.com");
    vi.mocked(fetchMarketText).mockResolvedValue("");
    expect(await getContextReport(date)).toBeNull();
    vi.mocked(fetchMarketText).mockRejectedValue(new Error("offline"));
    expect(await getContextReport(date)).toBeNull();
    expect(await getContextReport("../../secret")).toBeNull();
  });
});

describe("Context model evidence boundaries", () => {
  const fetchSummary = (text: string, evidenceIds: string[]) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ sentences: [{ text, evidenceIds }] }) } }] })));
  it("requires citations and rejects made-up evidence and unsupported causal/trading claims", async () => {
    const report = context(), ref = report.highlights[0].timeline[0].id;
    const options = { apiKey: "fixture-key", model: "fixture-model", now };
    await expect(generateContextSummary(report, { ...options, fetchImpl: fetchSummary("AMD 有事件报道。", ["event:invented"]) })).rejects.toThrow();
    await expect(generateContextSummary(report, { ...options, fetchImpl: fetchSummary("事件导致期权资金买入，建议立即加仓。", [ref]) })).rejects.toThrow();
    await expect(generateContextSummary(report, { ...options, fetchImpl: fetchSummary("不能证明风险但建议立即买入AMD", [ref]) })).rejects.toThrow();
    await expect(generateContextSummary(report, { ...options, fetchImpl: fetchSummary("AMD未发现期权流记录。", [ref]) })).rejects.toThrow();
    await expect(generateContextSummary(report, { ...options, fetchImpl: fetchSummary("AMD同日记录到2H和4H模型持仓快照。", [ref]) })).rejects.toThrow();
    await expect(generateContextSummary(report, { ...options, fetchImpl: fetchSummary("本次已保存的部分样本未收录相关记录，覆盖仍不完整。", [ref]) })).resolves.toMatchObject({ inputHash: contextEvidenceHash(report) });
    await expect(generateContextSummary(report, { ...options, fetchImpl: fetchSummary("事件与期权流的先后关系不能证明因果。", [ref]) })).resolves.toMatchObject({ inputHash: contextEvidenceHash(report) });
  });
  it("keeps observations usable when model is missing or fails", async () => {
    const report = context();
    expect((await analyzeContext(report, null, { analyze: true, model: "test", now })).summaryStatus).toBe("unavailable");
    const failed = await analyzeContext(report, null, { analyze: true, apiKey: "fixture", model: "test", now, generate: async () => { throw new Error("no"); } });
    expect(failed.observations).toEqual(report.observations); expect(failed.summary).toBeNull();
  });
  it("accepts extra valid candidates and nine citations without truncating evidence, retaining one sentence per stock", async () => {
    const report = context(), first = report.observations[0];
    first.events = Array.from({ length: 8 }, (_, i) => ({ ...first.events[0], id: `fixture-${i}` }));
    first.flows = [{ id: "fixture-flow", sourceUrl: null, postedAt: "2026-09-25T14:00:00.000Z", firstObservedAt: null, updatedAt: null, anchorDate: date, right: "call", side: "unknown", direction: "unknown", premium: 100000, strike: 100, expiry: null, provenanceStatus: "legacy-unknown", revision: null, evidenceHash: null, flags: [] }];
    first.timeline = [...first.events.map(event => ({ ...first.timeline[0], id: `event:${event.id}` })), { ...first.timeline[0], id: "flow:fixture-flow", track: "flow", title: "Unknown side call" }];
    const second = structuredClone(first); second.symbol = "GS"; second.events = [{ ...first.events[0], id: "gs-fixture" }]; second.flows = []; second.timeline = [{ ...first.timeline[0], id: "event:gs-fixture" }];
    const third = structuredClone(second); third.symbol = "JNJ"; third.events[0].id = "jnj-fixture"; third.timeline[0].id = "event:jnj-fixture";
    report.observations = [first, second, third]; report.highlights = report.observations;
    const sentences = [
      { text: "AMD 有事件报道。", evidenceIds: [first.timeline[0].id] },
      { text: "AMD 的事件与来源期权流记录在观察窗口内共现，不证明因果。", evidenceIds: first.timeline.map(item => item.id) },
      { text: "GS 本次已保存的部分样本未收录相关期权流记录，覆盖仍不完整。", evidenceIds: [second.timeline[0].id] },
      { text: "JNJ 有事件报道。", evidenceIds: [third.timeline[0].id] },
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ sentences }) } }] })));
    const summary = await generateContextSummary(report, { apiKey: "fixture-key", model: "fixture-model", now, fetchImpl });
    expect(summary.sentences).toHaveLength(3); expect(summary.sentences[0].evidenceIds).toHaveLength(9);
    expect(summary.sentences.map(row => row.text)).toEqual(sentences.slice(1).map(row => row.text));
    expect(parseContextReport({ ...report, summary, summaryStatus: "ready" }, now).summary?.sentences).toEqual(summary.sentences);
  });
});

describe("Event evidence revision history", () => {
  it("keeps first observation, immutable version time on repeats and prior versions on amendments", () => {
    const first = catalyst().events;
    const same = mergeCatalystEvents(first, [eventInput()], catalyst().universe, new Date("2026-09-26T03:00:00.000Z")).events;
    expect(same[0].evidenceUpdatedAt).toBe(stamp); expect(same[0].evidenceHistory).toEqual([]);
    const changed = mergeCatalystEvents(same, [{ ...eventInput(), title: "修订公告" }], catalyst().universe, new Date("2026-09-26T04:00:00.000Z")).events;
    expect(changed[0].firstSeenAt).toBe(stamp); expect(changed[0].evidenceUpdatedAt).toBe("2026-09-26T04:00:00.000Z");
    expect(changed[0].evidenceHistory?.[0].evidence.title).toBe(eventInput().title);
    const legacy = { ...changed[0], evidenceUpdatedAt: undefined, evidenceHistory: undefined };
    const recaptured = mergeCatalystEvents([legacy], [{ ...eventInput(), title: "修订公告" }], catalyst().universe, new Date("2026-09-26T05:00:00.000Z")).events[0];
    expect(recaptured.evidenceUpdatedAt).toBeNull();
  });
});
