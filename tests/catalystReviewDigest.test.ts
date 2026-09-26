import { describe, expect, it } from "vitest";
import { buildCatalystReviewDigest, parseCatalystReviewDigest } from "@/lib/catalyst/reviewDigest";
import type { CatalystEvent, CatalystReport, EventReaction, Relation, SourceHealth } from "@/lib/catalyst/types";
import type { DailyReview } from "@/lib/review/types";

const date = "2026-09-25", previous = "2026-09-24";
const capturedAt = "2026-09-26T02:00:00Z", builtAt = "2026-09-26T01:00:00Z";
const now = new Date(capturedAt);
const id = (number: number) => number.toString(16).padStart(24, "0");
function health(source: string, state: SourceHealth["state"] = "ok"): SourceHealth {
  return { id: source, label: source, state, checkedAt: capturedAt, count: 1, detail: "fixture" };
}
function relation(kind: Relation["kind"] = "portfolio", overrides: Partial<Relation> = {}): Relation {
  return { kind, key: kind === "market" ? "market:US" : kind === "sector" ? "sector:TECH" : kind + ":2h:AMD",
    label: kind, asOf: date, observedAt: capturedAt, ...(kind === "portfolio" || kind === "signal" ? { tf: "2h" as const } : {}), ...overrides };
}
function event(number = 1, overrides: Partial<CatalystEvent> = {}): CatalystEvent {
  return { id: id(number), provider: "feed", externalId: String(number), sourceName: "Fixture",
    sourceUrl: "https://news.example.com/" + number, title: "AMD earnings " + number, excerpt: "",
    type: "Earnings", importance: "high", symbols: ["AMD"], sectorIds: ["TECH"], scope: "stock",
    publishedAt: "2026-09-25T16:00:00Z", eventAt: "2026-09-25T16:00:00Z", eventDate: date,
    timePrecision: "minute", session: "regular", timing: "confirmed", status: "published", sourceUpdatedAt: null,
    firstSeenAt: capturedAt, lastSeenAt: capturedAt, revision: 1, backfilled: false,
    firstRelations: [relation()], currentRelations: [relation()], relatedSourceUrls: [], ...overrides };
}
function scheduled(number = 10, overrides: Partial<CatalystEvent> = {}): CatalystEvent {
  return event(number, { title: "AMD next earnings " + number, status: "scheduled", publishedAt: null,
    eventAt: "2026-09-26T12:00:00Z", eventDate: "2026-09-26", ...overrides });
}
function report(events = [event()]): CatalystReport {
  return { version: 1, generatedAt: capturedAt, asOf: date, sessions: [previous, date],
    universe: { asOf: date, observedAt: capturedAt,
      symbols: [{ symbol: "AMD", name: "AMD", sectorId: "TECH", industry: "Semiconductors",
        relations: [relation(), relation("signal"), relation("opportunity")] }],
      sectors: [{ id: "TECH", name: "信息科技", etf: "XLK", leader: true, asOf: date }],
      signals: [], health: [health("portfolio-2h"), health("signal-journal"), health("opportunity")] },
    sources: [health("feed"), health("reaction-prices")], events, reactions: [], summary: null,
    summaryStatus: "not-requested", warnings: [] };
}
function review(): DailyReview {
  return { version: 1, date, previousDate: previous, builtAt,
    market: { regime: "Neutral", summary: "", metrics: [],
      breadth: { today: null, yesterday: null, valid: 0, total: 0, universe: "SP500", membershipAsOf: date },
      strongSectors: { today: null, yesterday: null, total: 11 } },
    options: [], sectors: [{ symbol: "XLK", name: "信息科技", group: "sector", rps: 73, d1: -2, d5: 3, d20: 5, return20: 6, change: 1 }],
    signals: [], accounts: [], warnings: [] };
}
function reaction(): EventReaction {
  const missing = { date: null, value: null, status: "missing" as const };
  return { eventId: id(1), symbol: "AMD", asOf: date, anchorDate: date, baseline: { date: previous, close: 100 }, basis: "fixture",
    price: { t0: { date, value: 0, status: "ready" }, t1: missing, t3: missing, t5: missing },
    rps: { metric: "composite-daily-sp500-v1", before: { date: previous, value: 60, status: "ready" }, after: { date, value: 65.5, status: "ready" } },
    sector: { metric: "sector-etf-20d-excess-spy-v1", etf: "XLK", before: { date: previous, value: 100, status: "ready" }, after: { date, value: 200, status: "ready" } },
    mfe: missing, mae: missing, signalsAfter: [] };
}
const build = (input = report(), daily = review()) => buildCatalystReviewDigest(input, daily);

describe("independent post-review Catalyst digest", () => {
  it("captures newly observed evidence after review publication without mutating either input", () => {
    const input = report([event(1, { firstSeenAt: "2026-09-26T01:30:00Z", sourceUpdatedAt: "2026-09-26T01:45:00Z" })]);
    const daily = review(), before = JSON.stringify({ input, daily });
    const digest = build(input, daily);
    expect(digest).toMatchObject({ reviewDate: date, reviewBuiltAt: builtAt, capturedAt, status: "ready" });
    expect(digest.today).toHaveLength(1);
    expect(JSON.stringify({ input, daily })).toBe(before);
    expect(parseCatalystReviewDigest(digest, date, now)).toEqual(digest);
  });
  it("requires a matching settled date and a collection after the existing review", () => {
    expect(() => build({ ...report(), asOf: previous })).toThrow();
    expect(() => build({ ...report(), generatedAt: "2026-09-26T00:59:00Z" })).toThrow();
  });
  it("prioritizes Portfolio then Signal, reserves one useful future item, and caps both lists", () => {
    const input = report([
      event(1, { currentRelations: [relation("market")], symbols: [], scope: "market" }),
      event(2, { currentRelations: [relation("sector")], symbols: [], scope: "sector" }),
      event(3, { importance: "medium", currentRelations: [relation("signal")] }),
      event(4, { importance: "medium" }),
      ...[10, 11, 12, 13].map(n => scheduled(n)),
    ]);
    const digest = build(input);
    expect(digest.today.map(row => row.id)).toEqual([id(4), id(3), id(10)]);
    expect(digest.upcoming).toHaveLength(3);
    expect(digest.today.filter(row => row.kind === "upcoming")).toHaveLength(1);
    expect(digest.upcoming.every(row => row.priceChange === null && row.rpsChange === null && row.sectorRpsChange === null)).toBe(true);
  });
  it("excludes Opportunity-only, low importance, and medium sector/market events", () => {
    const input = report([
      event(1, { currentRelations: [relation("opportunity")] }),
      event(2, { importance: "low" }),
      event(3, { importance: "medium", scope: "sector", symbols: [], currentRelations: [relation("sector")] }),
      event(4, { importance: "medium", scope: "market", symbols: [], currentRelations: [relation("market")] }),
    ]);
    expect(build(input).today).toEqual([]);
  });
  it("filters Corporate CEO commentary while retaining a concrete leadership appointment", () => {
    const input = report([
      event(1, { type: "Corporate", importance: "medium", title: "Elon Musk Responds With Two Emojis as Google CEO Sundar Pichai Says Project Suncatcher Will Transform AI" }),
      event(2, { type: "Corporate", importance: "medium", title: "AMD appoints new CEO following leadership change" }),
    ]);
    expect(build(input).today.map(row => row.id)).toEqual([id(2)]);
  });
  it("deduplicates repeated headlines, keeps distinct macro items, and ranks deterministically", () => {
    const input = report([
      event(3, { title: "Consumer Price Index", type: "Macro", scope: "market", symbols: [], currentRelations: [relation("market")] }),
      event(2, { title: "Jobs report", type: "Macro", scope: "market", symbols: [], currentRelations: [relation("market")] }),
      event(1, { title: "  jobs   report  ", type: "Macro", scope: "market", symbols: [], currentRelations: [relation("market")] }),
    ]);
    const digest = build(input);
    expect(digest.today.map(row => row.id)).toEqual([id(1), id(3)]);
    expect(build({ ...input, events: [...input.events].reverse() })).toEqual(digest);
  });
});

describe("ET schedule and evidence time boundaries", () => {
  it("includes the first 24 hours and exact 72-hour end but excludes now, later and cancelled events", () => {
    const input = report([
      scheduled(1, { eventAt: capturedAt, eventDate: date }),
      scheduled(2),
      scheduled(3, { eventAt: "2026-09-29T02:00:00Z", eventDate: "2026-09-28" }),
      scheduled(4, { eventAt: "2026-09-29T02:00:01Z", eventDate: "2026-09-28" }),
      scheduled(5, { status: "cancelled" }), scheduled(6, { timing: "unknown" }),
    ]);
    expect(build(input).upcoming.map(row => row.id)).toEqual([id(2), id(3)]);
  });
  it("keeps estimated date/session precision without inventing midnight or including ambiguous dates", () => {
    const input = report([
      scheduled(1, { timePrecision: "date", eventAt: null, eventDate: date }),
      scheduled(2, { timePrecision: "date", eventAt: null, timing: "estimated" }),
      scheduled(3, { timePrecision: "session", eventAt: null, eventDate: "2026-09-27", session: "after" }),
      scheduled(4, { timePrecision: "date", eventAt: null, eventDate: "2026-09-28" }),
    ]);
    const upcoming = build(input).upcoming;
    expect(upcoming.map(row => row.id)).toEqual([id(2), id(3)]);
    expect(upcoming[0].timeLabel).toContain("具体时间待确认 ET · 预计");
    expect(upcoming[1].timeLabel).toContain("盘后");
    expect(upcoming.every(row => !row.timeLabel.includes("00:00"))).toBe(true);
  });
  it("uses the ET publication date and preserves a genuinely unknown publication time", () => {
    const input = report([
      event(1, { publishedAt: "2026-09-25T02:00:00Z" }),
      event(2, { publishedAt: null, eventAt: null, timePrecision: "date" }),
    ]);
    expect(build(input).today.map(row => row.id)).toEqual([id(2)]);
    expect(build(input).today[0].timeLabel).toContain("具体时间待确认");
  });
  it("includes a Monday premarket interval inside Friday's 72-hour boundary without inventing an event time", () => {
    const at = "2026-09-25T21:00:00Z", input = report([scheduled(1, { eventDate: "2026-09-28", eventAt: null, timePrecision: "session", session: "pre" })]);
    input.generatedAt = at; input.universe.observedAt = at;
    input.sources.forEach(source => { source.checkedAt = at; });
    input.universe.health.forEach(source => { source.checkedAt = at; });
    input.universe.symbols.forEach(row => row.relations.forEach(link => { link.observedAt = at; }));
    input.events.forEach(row => {
      row.firstSeenAt = at; row.lastSeenAt = at;
      row.currentRelations.forEach(link => { link.observedAt = at; });
    });
    const daily = { ...review(), builtAt: "2026-09-25T20:30:00Z" };
    const upcoming = build(input, daily).upcoming;
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].timeLabel).toBe("2026-09-28 盘前 · 具体时间待确认 ET");
    input.events[0].timePrecision = "date";
    expect(build(input, daily).upcoming).toEqual([]);
  });
  it("retains explicit after-hours context in exact-time labels", () => {
    expect(build(report([event(1, { session: "after", publishedAt: "2026-09-25T21:00:00Z" })])).today[0].timeLabel).toContain("ET · 盘后");
  });
  it.each(["firstSeenAt", "sourceUpdatedAt", "publishedAt"] as const)("excludes future %s and does not claim complete coverage", field => {
    const digest = build(report([event(1, { [field]: "2026-09-26T02:00:01Z" })]));
    expect(digest.today).toEqual([]);
    expect(digest.status).toBe("partial");
  });
  it("does not revive old future schedules when their provider failed or did not observe them this run", () => {
    const input = report([scheduled()]);
    input.sources[0].state = "unavailable";
    expect(build(input).upcoming).toEqual([]);
    expect(build(input).status).toBe("unavailable");
    const unseen = report([scheduled(10, { lastSeenAt: builtAt })]);
    expect(build(unseen).upcoming).toEqual([]);
    expect(build(unseen).status).toBe("partial");
  });
});

describe("current relation and coverage guards", () => {
  it.each(["first-only", "removed", "stale-asof", "future-asof", "future-observed"] as const)("rejects invalid current portfolio evidence: %s", mode => {
    const input = report();
    if (mode === "first-only") input.events[0].currentRelations = [];
    if (mode === "removed") input.universe.symbols = [];
    if (mode === "stale-asof" || mode === "future-asof") {
      const value = mode === "stale-asof" ? previous : "2026-09-26T03:00:00Z";
      input.events[0].currentRelations[0].asOf = value;
      input.universe.symbols[0].relations[0].asOf = value;
    }
    if (mode === "future-observed") input.universe.observedAt = "2026-09-26T03:00:00Z";
    expect(build(input).today).toEqual([]);
  });
  it("allows a recent real signal relation but not one older than the selected ten-day window", () => {
    const current = relation("signal", { asOf: "2026-09-20" });
    const input = report([event(1, { currentRelations: [current] })]);
    input.universe.symbols[0].relations = [current];
    expect(build(input).today[0].relation).toBe("Signal");
    current.asOf = "2026-09-14";
    expect(build(input).today).toEqual([]);
  });
  it("distinguishes healthy empty scope, partial coverage, unavailable and future health", () => {
    expect(build(report([])).status).toBe("ready");
    const partial = report([]); partial.universe.health[0].state = "unavailable";
    expect(build(partial).status).toBe("partial");
    const unavailable = report([]); unavailable.sources[0].state = "disabled";
    expect(build(unavailable).status).toBe("unavailable");
    const future = report(); future.sources[0].checkedAt = "2026-09-26T02:00:01Z";
    expect(build(future).status).toBe("unavailable");
    expect(build(future).today).toEqual([]);
  });
});

describe("date-limited reaction metrics", () => {
  it("preserves zero T0, uses same-date comparable RPS and actual review sector d1", () => {
    const input = report(); input.reactions = [reaction()];
    expect(build(input).today[0]).toMatchObject({ priceChange: 0, rpsChange: 5.5, sectorRpsChange: -2 });
  });
  it("hides a future RPS update, mismatched prior RPS date and after-close pending T0", () => {
    const input = report(); const row = reaction(); input.reactions = [row];
    row.rps.after.date = "2026-09-28";
    row.price.t0 = { date: "2026-09-28", value: null, status: "pending" };
    expect(build(input).today[0]).toMatchObject({ priceChange: null, rpsChange: null, sectorRpsChange: -2 });
    row.rps.after.date = date; row.rps.before.date = "2026-09-23";
    expect(build(input).today[0].rpsChange).toBeNull();
  });
  it("does not use future reaction anchors, date-only event price or an unrelated sector ETF", () => {
    const input = report(); input.reactions = [reaction()];
    input.reactions[0].anchorDate = "2026-09-28";
    expect(build(input).today[0].priceChange).toBeNull();
    input.reactions[0].anchorDate = date; input.events[0].timePrecision = "date";
    expect(build(input).today[0]).toMatchObject({ priceChange: null, rpsChange: null });
    input.universe.symbols[0].sectorId = null;
    expect(build(input).today[0].sectorRpsChange).toBeNull();
  });
});

describe("archive parser validation", () => {
  it("rejects date mismatch and capture more than sixty seconds in the future", () => {
    const digest = build();
    expect(() => parseCatalystReviewDigest(digest, previous, now)).toThrow();
    expect(() => parseCatalystReviewDigest(digest, date, new Date(now.getTime() - 60_001))).toThrow();
    expect(parseCatalystReviewDigest(digest, date, new Date(now.getTime() - 60_000))).toEqual(digest);
  });
  it.each(["javascript:alert(1)", "https://user:password@example.com/item", "https://example.com/item?token=private", "http://example.com/item"])("rejects unsafe source URL %s", url => {
    const digest = build(); digest.today[0].sourceUrl = url;
    expect(() => parseCatalystReviewDigest(digest, date, now)).toThrow();
  });
  it("rejects non-finite metrics, extra items, duplicate ids and invalid dates", () => {
    const original = build();
    const metric = structuredClone(original); metric.today[0].priceChange = Infinity;
    expect(() => parseCatalystReviewDigest(metric, date, now)).toThrow();
    const duplicate = structuredClone(original); duplicate.today.push({ ...duplicate.today[0] });
    expect(() => parseCatalystReviewDigest(duplicate, date, now)).toThrow();
    const extra = structuredClone(original); extra.today = [1, 2, 3, 4].map(n => ({ ...extra.today[0], id: id(n) }));
    expect(() => parseCatalystReviewDigest(extra, date, now)).toThrow();
    const invalid = structuredClone(original); invalid.today[0].eventDate = "2026-02-30";
    expect(() => parseCatalystReviewDigest(invalid, date, now)).toThrow();
  });
  it("rejects numeric forecasts in upcoming items and inconsistent duplicated future slots", () => {
    const digest = build(report([scheduled()]));
    digest.upcoming[0].priceChange = 1;
    expect(() => parseCatalystReviewDigest(digest, date, now)).toThrow();
    digest.upcoming[0].priceChange = null; digest.today[0].title = "different evidence";
    expect(() => parseCatalystReviewDigest(digest, date, now)).toThrow();
  });
});
