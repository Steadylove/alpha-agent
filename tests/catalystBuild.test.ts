import { afterEach, describe, expect, it, vi } from "vitest";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { assembleCatalystReport, loadCatalystMarket, saveCatalystReport, type BuildDependencies } from "@/lib/catalyst/build";
import { fingerprint, mergeCatalystEvents, parseCatalystReport } from "@/lib/catalyst/normalize";
import { catalystEvidence } from "@/lib/catalyst/summary";
import type { CatalystReport, CatalystUniverse, EventInput, ProviderResult, SourceHealth } from "@/lib/catalyst/types";
import type { PanelBars } from "@/lib/backtest/panel";

const now = new Date("2026-09-26T04:00:00Z");
const later = new Date("2026-09-26T05:00:00Z");
const days = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
function health(id = "test-news", state: SourceHealth["state"] = "ok"): SourceHealth {
  return { id, label: "Fixture 新闻", state, checkedAt: now.toISOString(), count: 1, detail: "Fixture coverage" };
}
function universe(at = now): CatalystUniverse {
  return { asOf: "2026-09-25", observedAt: at.toISOString(),
    symbols: [{ symbol: "AMD", name: "AMD", sectorId: "technology", industry: "Semiconductors", relations: [{ kind: "portfolio", key: "portfolio:2h:AMD", label: "2H 模型持仓 · AMD", tf: "2h", asOf: "2026-09-25", observedAt: at.toISOString() }] }],
    sectors: [{ id: "technology", name: "科技", etf: "XLK", leader: true, asOf: "2026-09-25" }], signals: [], health: [],
  };
}
function input(overrides: Partial<EventInput> = {}): EventInput {
  return { provider: "test-news", externalId: "news-1", sourceName: "Fixture News", sourceUrl: "https://news.example.net/amd-1", title: "AMD reports financial results", excerpt: "已公布经营结果。", type: "Earnings", importance: "high", symbols: ["AMD"], sectorIds: ["technology"], scope: "stock", publishedAt: "2026-09-25T14:00:00.000Z", eventAt: "2026-09-25T14:00:00.000Z", eventDate: "2026-09-25", timePrecision: "minute", session: "regular", timing: "confirmed", status: "published", sourceUpdatedAt: "2026-09-25T14:00:00.000Z", ...overrides };
}
function panel(ticker: string): PanelBars {
  return { ticker, dates: days, close: Float32Array.from(days.map((_, i) => 100 + i)), high: Float32Array.from(days.map((_, i) => 101 + i)), low: Float32Array.from(days.map((_, i) => 99 + i)), volume: null, open: null };
}
function deps(inputs: EventInput[] = [input()], overrides: Partial<BuildDependencies> = {}): BuildDependencies {
  return {
    universe: vi.fn(async at => universe(at)),
    collect: vi.fn(async () => [{ events: inputs, health: { ...health(), count: inputs.length } }]),
    market: vi.fn(async u => ({ universe: u, sessions: days, sessionCloses: Object.fromEntries(days.map(day => [day, "16:00"])), asOf: "2026-09-25", panels: new Map([["AMD", panel("AMD")], ["SPY", panel("SPY")], ["XLK", panel("XLK")]]), scale: null, health: [health("reaction-prices")] })),
    summarize: vi.fn(async (evidence, options) => ({ generatedAt: options.now.toISOString(), inputHash: fingerprint(evidence), model: options.model, sentences: [{ text: "AMD 已公布经营结果，后续变化仍需持续观察。", eventIds: [evidence.events[0].id] }] })),
    ...overrides,
  };
}
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Catalyst immutable first observation and revisions", () => {
  it("freezes first relations and discovery time, while current relations follow the current universe", () => {
    const first = mergeCatalystEvents([], [input()], universe(), now).events[0];
    const changedUniverse = universe(later);
    changedUniverse.symbols[0].relations = [{ kind: "opportunity", key: "opportunity:AMD", label: "Opportunity · AMD", asOf: "2026-09-25", observedAt: later.toISOString() }];
    const revised = mergeCatalystEvents([first], [input({ excerpt: "原来源更新了说明。", sourceUpdatedAt: "2026-09-26T04:30:00.000Z" })], changedUniverse, later).events[0];
    expect(revised.id).toBe(first.id); expect(revised.revision).toBe(2);
    expect(revised.firstSeenAt).toBe(now.toISOString()); expect(revised.lastSeenAt).toBe(later.toISOString());
    expect(revised.firstRelations).toEqual(first.firstRelations);
    expect(revised.currentRelations.some(r => r.kind === "portfolio")).toBe(false);
    expect(revised.currentRelations.some(r => r.kind === "opportunity")).toBe(true);
    expect(revised.backfilled).toBe(true);
  });
  it("does not create revisions for identical polls and retains source failure history", () => {
    const original = mergeCatalystEvents([], [input()], universe(), now).events;
    const same = mergeCatalystEvents(original, [input()], universe(later), later).events;
    expect(same[0].revision).toBe(1);
    const missingSource = mergeCatalystEvents(same, [], universe(later), later).events;
    expect(missingSource[0].firstSeenAt).toBe(original[0].firstSeenAt);
    expect(missingSource[0].lastSeenAt).toBe(same[0].lastSeenAt);
    expect(original[0].lastSeenAt).toBe(now.toISOString());
  });
  it("merges exact syndicated reports while retaining links from both sources", () => {
    const copy = input({ provider: "second-news", externalId: "second-1", sourceUrl: "https://other.example.net/amd" });
    const merged = mergeCatalystEvents([], [input(), copy], universe(), now);
    expect(merged.events).toHaveLength(1);
    expect(merged.events[0].relatedSourceUrls).toEqual(expect.arrayContaining([input().sourceUrl, copy.sourceUrl]));
  });
  it("keeps current source confirmation when an equivalent schedule moves to a new provider", () => {
    const schedule = input({ provider: "old-calendar", publishedAt: null, status: "scheduled", eventDate: "2026-10-01", eventAt: null, timePrecision: "date", session: "unknown", timing: "estimated" });
    const first = mergeCatalystEvents([], [schedule], universe(), now).events;
    const nextSource = { ...schedule, provider: "new-calendar", sourceName: "New Calendar", sourceUrl: "https://calendar.example.net/amd" };
    const merged = mergeCatalystEvents(first, [nextSource], universe(later), later);
    expect(merged.events).toHaveLength(1);
    expect(merged.events[0]).toMatchObject({ provider: "new-calendar", sourceName: "New Calendar", lastSeenAt: later.toISOString() });
    expect(merged.events[0].relatedSourceUrls).toEqual(expect.arrayContaining([schedule.sourceUrl, nextSource.sourceUrl]));
    expect(first[0].lastSeenAt).toBe(now.toISOString());
  });
  it("keeps different-time events separate even when their headline, stock and day coincide", () => {
    const second = input({ externalId: "news-2", sourceUrl: "https://news.example.net/amd-2", publishedAt: "2026-09-25T20:00:00.000Z", eventAt: "2026-09-25T20:00:00.000Z", session: "after" });
    expect(mergeCatalystEvents([], [input(), second], universe(), now).events).toHaveLength(2);
  });
  it("rejects invalid dates, future publication and unsafe links without losing valid events", () => {
    const merged = mergeCatalystEvents([], [input(), input({ externalId: "bad-date", eventDate: "2026-02-30" }), input({ externalId: "future", publishedAt: "2026-09-27T14:00:00.000Z" }), input({ externalId: "link", sourceUrl: "javascript:alert(1)" })], universe(), now);
    expect(merged.events).toHaveLength(1); expect(merged.rejected).toBe(3);
  });
  it("keeps a cancelled calendar revision under the same stable event ID", () => {
    const scheduled = input({ provider: "bls-calendar", externalId: "cpi-id", title: "Consumer Price Index", type: "Macro", scope: "market", symbols: [], sectorIds: [], publishedAt: null, status: "scheduled", eventDate: "2026-10-02", eventAt: "2026-10-02T12:30:00.000Z" });
    const first = mergeCatalystEvents([], [scheduled], universe(), now).events;
    const revised = mergeCatalystEvents(first, [{ ...scheduled, status: "cancelled" }], universe(later), later).events;
    expect(revised[0]).toMatchObject({ id: first[0].id, revision: 2, status: "cancelled", firstSeenAt: now.toISOString() });
  });
});

describe("independent report assembly", () => {
  it("assembles known events and daily reactions without calling a model by default", async () => {
    const dependencies = deps(); const report = await assembleCatalystReport(null, { now }, dependencies);
    expect(report.events).toHaveLength(1); expect(report.reactions).toHaveLength(1);
    expect(report.reactions[0].price.t0.status).toBe("ready");
    expect(report.reactions[0].price.t1.status).toBe("pending");
    expect(report.summaryStatus).toBe("not-requested"); expect(dependencies.summarize).not.toHaveBeenCalled();
    expect(parseCatalystReport(report)).toEqual(report);
  });
  it("retains prior events when the source fails and exposes the failed current health", async () => {
    const previous = await assembleCatalystReport(null, { now }, deps());
    const unavailable: ProviderResult = { events: [], health: { ...health("test-news", "unavailable"), count: 0, checkedAt: later.toISOString(), detail: "来源暂不可用" } };
    const report = await assembleCatalystReport(previous, { now: later }, deps([], { collect: async () => [unavailable] }));
    expect(report.events[0].id).toBe(previous.events[0].id);
    expect(report.events[0].lastSeenAt).toBe(previous.events[0].lastSeenAt);
    expect(report.sources[0].state).toBe("unavailable");
  });
  it("keeps events available when model generation fails and marks prior commentary stale", async () => {
    const previous = await assembleCatalystReport(null, { now, analyze: true, apiKey: "fixture-key" }, deps());
    expect(previous.summaryStatus).toBe("ready");
    const changed = input({ excerpt: "公告新增说明，等待进一步核实。" });
    const dependencies = deps([changed], { summarize: vi.fn(async () => { throw new Error("upstream secret-key payload"); }) });
    const report = await assembleCatalystReport(previous, { now: later, analyze: true, apiKey: "fixture-key" }, dependencies);
    expect(report.events[0].excerpt).toBe(changed.excerpt);
    expect(report.summaryStatus).toBe("stale"); expect(report.summary).toEqual(previous.summary);
    expect(JSON.stringify(report.warnings)).not.toContain("secret-key");
    expect(report.warnings.join(" ")).toContain("未作为当前结论展示");
  });
  it("reports first-time model failure/missing credentials without failing event collection", async () => {
    const unavailable = await assembleCatalystReport(null, { now, analyze: true }, deps());
    expect(unavailable.summaryStatus).toBe("unavailable"); expect(unavailable.events).toHaveLength(1);
    const failure = await assembleCatalystReport(null, { now, analyze: true, apiKey: "fixture-key" }, deps(undefined, { summarize: async () => { throw new Error("model error"); } }));
    expect(failure.summaryStatus).toBe("unavailable"); expect(failure.summary).toBeNull(); expect(failure.events).toHaveLength(1);
  });
  it("reuses cached valid commentary for unchanged evidence without another paid request", async () => {
    const originalDeps = deps(); const previous = await assembleCatalystReport(null, { now, analyze: true, apiKey: "fixture-key" }, originalDeps);
    const nextDeps = deps(); const report = await assembleCatalystReport(previous, { now: later, analyze: true, apiKey: "fixture-key" }, nextDeps);
    expect(report.summaryStatus).toBe("ready"); expect(nextDeps.summarize).not.toHaveBeenCalled();
    expect(report.summary?.inputHash).toBe(fingerprint(catalystEvidence(report, later)));
  });
  it("regenerates unchanged evidence when analysis explicitly selects a different model", async () => {
    const previous = await assembleCatalystReport(null, { now, analyze: true, apiKey: "fixture-key", model: "model-first" }, deps());
    const next = deps();
    const report = await assembleCatalystReport(previous, { now: later, analyze: true, apiKey: "fixture-key", model: "model-next" }, next);
    expect(next.summarize).toHaveBeenCalledTimes(1);
    expect(report.summary?.model).toBe("model-next");
    const collector = deps();
    const unchanged = await assembleCatalystReport(previous, { now: later, model: "model-next" }, collector);
    expect(collector.summarize).not.toHaveBeenCalled();
    expect(unchanged.summaryStatus).toBe("ready");
    expect(unchanged.summary?.model).toBe("model-first");
  });
  it("never calls the model when there are no referenceable events", async () => {
    const dependencies = deps([]);
    const report = await assembleCatalystReport(null, { now, analyze: true, apiKey: "fixture-key" }, dependencies);
    expect(report.events).toHaveLength(0); expect(report.summaryStatus).toBe("not-requested");
    expect(dependencies.summarize).not.toHaveBeenCalled();
  });
  it("does not calculate reactions from date-only publications or planned calendar events", async () => {
    const report = await assembleCatalystReport(null, { now }, deps([input({ publishedAt: null, eventAt: null, timePrecision: "date", session: "unknown" }), input({ externalId: "scheduled", title: "Next AMD earnings", publishedAt: null, eventAt: null, timePrecision: "date", status: "scheduled", eventDate: "2026-10-01" })]));
    expect(report.reactions).toHaveLength(1);
    expect(report.reactions[0].anchorDate).toBeNull();
    expect(report.reactions[0].price.t0.status).toBe("unavailable");
    expect(report.reactions[0].mfe.status).toBe("unavailable");
  });
  it("keeps reactions unavailable if real exchange close times are absent", async () => {
    const dependencies = deps(), market = dependencies.market;
    dependencies.market = async (...args) => ({ ...await market(...args), sessionCloses: {} });
    const report = await assembleCatalystReport(null, { now }, dependencies);
    expect(report.reactions[0].price.t0.status).toBe("unavailable");
    expect(report.reactions[0].anchorDate).toBeNull();
  });
  it.each(["later-publication", "unknown-time", "missing-calendar"])("revalidates archived signals when the current window changes: %s", async (scenario) => {
    const initial = deps();
    initial.universe = async at => ({ ...universe(at), signals: [{ id: "old-signal:buy", symbol: "AMD", tf: "2h", event: "buy", signalTime: "2026-09-25T15:00:00Z", capturedAt: "2026-09-25T15:00:01Z" }] });
    const previous = await assembleCatalystReport(null, { now }, initial);
    expect(previous.reactions[0].signalsAfter).toHaveLength(1);
    const revised = input(scenario === "later-publication" ? { publishedAt: "2026-09-25T16:00:00Z", eventAt: "2026-09-25T16:00:00Z" } : scenario === "unknown-time" ? { timePrecision: "unknown" } : {});
    const current = deps([revised]);
    if (scenario === "missing-calendar") {
      const market = current.market;
      current.market = async (...args) => ({ ...await market(...args), sessionCloses: {} });
    }
    const report = await assembleCatalystReport(previous, { now: later }, current);
    expect(report.reactions[0].signalsAfter).toEqual([]);
    expect(previous.reactions[0].signalsAfter).toHaveLength(1);
  });
  it("retains archived captures absent from the current short signal list when still in the valid window", async () => {
    const initial = deps();
    initial.universe = async at => ({ ...universe(at), signals: [{ id: "old-signal:buy", symbol: "AMD", tf: "2h", event: "buy", signalTime: "2026-09-25T15:00:00Z", capturedAt: "2026-09-25T15:00:01Z" }] });
    const previous = await assembleCatalystReport(null, { now }, initial);
    const report = await assembleCatalystReport(previous, { now: later }, deps());
    expect(report.universe.signals).toEqual([]);
    expect(report.reactions[0].signalsAfter.map(signal => signal.id)).toEqual(["old-signal:buy"]);
  });
});

describe("safe independent archive publication", () => {
  it("validates before replacing latest and preserves a previously successful snapshot on invalid input", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "catalyst-save-")); dirs.push(directory);
    const report = await assembleCatalystReport(null, { now }, deps()); saveCatalystReport(report, directory);
    const original = readFileSync(path.join(directory, "latest.json"), "utf8");
    const malformed = structuredClone(report); malformed.events[0].sourceUrl = "javascript:steal()";
    expect(() => saveCatalystReport(malformed, directory)).toThrow();
    expect(readFileSync(path.join(directory, "latest.json"), "utf8")).toBe(original);
  });
  it("writes immutable hash-distinguished editions and does not duplicate identical saves", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "catalyst-editions-")); dirs.push(directory);
    const report = await assembleCatalystReport(null, { now }, deps()); saveCatalystReport(report, directory); saveCatalystReport(report, directory);
    const history = path.join(directory, "history", "2026-09-26"), first = readdirSync(history);
    expect(first).toHaveLength(1);
    const oldBytes = readFileSync(path.join(history, first[0]), "utf8");
    const amended = structuredClone(report); amended.warnings = ["附加数据覆盖说明"];
    saveCatalystReport(amended, directory);
    expect(readdirSync(history)).toHaveLength(2);
    expect(readFileSync(path.join(history, first[0]), "utf8")).toBe(oldBytes);
    expect(JSON.parse(readFileSync(path.join(directory, "latest.json"), "utf8")).warnings).toEqual(amended.warnings);
  });
  it("retains the last two generated editions per UTC day while latest remains independent", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "catalyst-bounded-")); dirs.push(directory);
    const report = await assembleCatalystReport(null, { now }, deps());
    const history = path.join(directory, "history", "2026-09-26");
    saveCatalystReport(report, directory);
    const first = readdirSync(history)[0];
    const second = { ...report, generatedAt: later.toISOString(), warnings: ["第二版"] };
    saveCatalystReport(second, directory);
    const secondFile = readdirSync(history).find(file => file !== first)!;
    const secondBytes = readFileSync(path.join(history, secondFile), "utf8");
    const third = { ...report, generatedAt: "2026-09-26T06:00:00.000Z", warnings: ["第三版"] };
    saveCatalystReport(third, directory);
    expect(readdirSync(history)).toHaveLength(2);
    expect(existsSync(path.join(history, first))).toBe(false);
    expect(readFileSync(path.join(history, secondFile), "utf8")).toBe(secondBytes);
    expect(JSON.parse(readFileSync(path.join(directory, "latest.json"), "utf8"))).toEqual(third);
  });
  it("expires only generated regular snapshots older than the inclusive 45-day window", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "catalyst-expiry-")); dirs.push(directory);
    const history = path.join(directory, "history");
    const put = (day: string, file: string) => { const folder = path.join(history, day); mkdirSync(folder, { recursive: true }); const target = path.join(folder, file); writeFileSync(target, "retain-or-prune"); return target; };
    const expired = put("2026-08-12", "2026-08-12T04-00-00-000Z-aaaaaaaaaaaa.json");
    const oldestRetained = put("2026-08-13", "2026-08-13T04-00-00-000Z-bbbbbbbbbbbb.json");
    const unknown = put("2026-08-12", "manual-notes.json");
    const invalidTime = put("2026-08-12", "2026-08-12T99-00-00-000Z-cccccccccccc.json");
    const wrongFolder = put("2026-08-12", "2026-08-11T04-00-00-000Z-dddddddddddd.json");
    const unknownFolder = put("manual", "2026-08-12T04-00-00-000Z-eeeeeeeeeeee.json");
    const futureFolder = put("2027-01-01", "2027-01-01T04-00-00-000Z-ffffffffffff.json");
    const external = path.join(directory, "other-module"); mkdirSync(external);
    const outside = path.join(external, "untouched.json"); writeFileSync(outside, "outside-module");
    const fileLink = path.join(history, "2026-08-12", "2026-08-12T04-00-00-000Z-123456789abc.json"); symlinkSync(outside, fileLink);
    const directoryLink = path.join(history, "2026-08-11"); symlinkSync(external, directoryLink);
    const report = await assembleCatalystReport(null, { now }, deps()); saveCatalystReport(report, directory);
    expect(existsSync(expired)).toBe(false);
    for (const file of [oldestRetained, unknown, invalidTime, wrongFolder, unknownFolder, futureFolder, fileLink, directoryLink]) expect(existsSync(file)).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("outside-module");
    expect(JSON.parse(readFileSync(path.join(directory, "latest.json"), "utf8"))).toEqual(report);
  });
  it("surfaces pruning failures after publication without deleting or reverting latest", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "catalyst-prune-failure-")); dirs.push(directory);
    const report = await assembleCatalystReport(null, { now }, deps()); saveCatalystReport(report, directory);
    const next = { ...report, generatedAt: later.toISOString(), warnings: ["新快照"] };
    const fail = vi.spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("permission denied fixture"); });
    syncBuiltinESMExports();
    expect(() => saveCatalystReport(next, directory)).toThrow("最新快照已保存，但历史清理失败");
    fail.mockRestore(); syncBuiltinESMExports();
    expect(JSON.parse(readFileSync(path.join(directory, "latest.json"), "utf8"))).toEqual(next);
    expect(readdirSync(path.join(directory, "history", "2026-09-26"))).toHaveLength(2);
  });
  it("does not start pruning when publication fails and propagates the failed write", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "catalyst-write-failure-")); dirs.push(directory);
    const report = await assembleCatalystReport(null, { now }, deps()); saveCatalystReport(report, directory);
    const latestBytes = readFileSync(path.join(directory, "latest.json"), "utf8");
    const fail = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename failed fixture"); });
    const reads = vi.spyOn(fs, "readdirSync");
    syncBuiltinESMExports();
    expect(() => saveCatalystReport({ ...report, generatedAt: later.toISOString() }, directory)).toThrow("rename failed fixture");
    expect(reads).not.toHaveBeenCalled(); fail.mockRestore(); reads.mockRestore(); syncBuiltinESMExports();
    expect(readFileSync(path.join(directory, "latest.json"), "utf8")).toBe(latestBytes);
  });
  it("rejects orphan references and inverted observation timestamps", async () => {
    const report = await assembleCatalystReport(null, { now }, deps());
    const orphan = structuredClone(report); orphan.reactions[0].eventId = "orphan";
    expect(() => parseCatalystReport(orphan)).toThrow("关联无效");
    const time = structuredClone(report); time.events[0].firstSeenAt = later.toISOString();
    expect(() => parseCatalystReport(time)).toThrow("关联无效");
    const invalidSummary: CatalystReport = { ...report, summary: { generatedAt: now.toISOString(), inputHash: "a".repeat(64), model: "test-model", sentences: [{ text: "未知事件。", eventIds: ["orphan"] }] }, summaryStatus: "ready" };
    expect(() => parseCatalystReport(invalidSummary)).toThrow("引用无效");
  });
});

function marketFixture(patch: { checkedAt?: string; omitClose?: boolean; staleStock?: boolean; wrongScale?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "catalyst-market-")); dirs.push(root);
  for (const sub of [".catalyst", "rps", "1d"]) mkdirSync(path.join(root, sub));
  vi.stubEnv("MARKET_DATA_DIR", root); vi.stubEnv("MARKET_DATA_BASE_URL", ""); vi.stubEnv("VERCEL", "");
  vi.stubEnv("ALPACA_API_KEY", "fixture-key"); vi.stubEnv("ALPACA_API_SECRET", "fixture-secret");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fixture upstream unavailable"); }));
  const sessions: string[] = [], cursor = new Date("2026-08-03T00:00:00Z");
  while (sessions.length < 60) { if (![0, 6].includes(cursor.getUTCDay())) sessions.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  const closes = Object.fromEntries(sessions.map(day => [day, "16:00"]));
  if (patch.omitClose) delete closes["2026-09-25"];
  writeFileSync(path.join(root, ".catalyst/calendar.json"), JSON.stringify({ checkedAt: patch.checkedAt ?? now.toISOString(), sessions, closes }));
  writeFileSync(path.join(root, "rps/rps-latest.json"), JSON.stringify({ calendar: { sessions } }));
  writeFileSync(path.join(root, "rps/rps-scale-spx.json"), JSON.stringify({ generatedAt: now.toISOString(), index: patch.wrongScale ? "OTHER" : "SP500", buckets: 99, dates: ["2026-09-25"], counts: [500], cuts: [Array.from({ length: 99 }, (_, i) => 50 + i)] }));
  for (const ticker of ["SPY", "AMD", "XLK"]) writeFileSync(path.join(root, `1d/${ticker}.csv`), `date,open,high,low,close,volume\n${ticker === "AMD" && patch.staleStock ? "2026-09-24" : "2026-09-25"},100,101,99,100,1000\n`);
}

describe("real market-source loading without network fixtures", () => {
  it.each(["future", "missing-close"])("does not reuse an unsafe calendar cache after upstream failure: %s", async scenario => {
    marketFixture(scenario === "future" ? { checkedAt: "2026-09-27T00:00:00Z" } : { omitClose: true });
    const market = await loadCatalystMarket(universe(), [], now);
    expect(market.sessionCloses).toEqual({});
    expect(market.health.find(source => source.id === "reaction-calendar")?.detail).toContain("缺少收盘时刻");
  });
  it("can retain a real past calendar on refresh failure while exposing partial freshness", async () => {
    marketFixture({ checkedAt: "2026-09-24T00:00:00Z" });
    const market = await loadCatalystMarket(universe(), [], now);
    expect(market.sessionCloses?.["2026-09-25"]).toBe("16:00");
    expect(market.health.find(source => source.id === "reaction-calendar")?.state).toBe("partial");
  });
  it("reports a stale stock panel and incompatible RPS scale rather than healthy coverage", async () => {
    marketFixture({ staleStock: true, wrongScale: true });
    const market = await loadCatalystMarket(universe(), [], now);
    expect(market.asOf).toBe("2026-09-25");
    expect(market.health.find(source => source.id === "reaction-prices")?.state).toBe("partial");
    expect(market.health.find(source => source.id === "reaction-rps")?.state).toBe("unavailable");
    expect(market.scale).toBeNull();
  });
});
