import { describe, expect, it } from "vitest";
import { associateEvent, loadCatalystUniverse, type CatalystUniverseLoaders } from "@/lib/catalyst/universe";
import type { EventInput } from "@/lib/catalyst/types";
import { emptyOpportunity, type OpportunityStock } from "@/lib/opportunity/types";
import type { JournalArchive, JournalSignal } from "@/lib/review/types";
import type { AlertPayload } from "@/lib/discord/tvAlertCopy";
import { tradeIdOf } from "@/lib/signals/journal";
import { bookCache } from "./liveBooksFixtures";

const now = new Date("2026-09-26T02:00:00Z");
const signalTime = Date.parse("2026-09-25T18:00:00Z");
const stock = (symbol: string, patch: Partial<OpportunityStock> = {}): OpportunityStock => ({ symbol, name: symbol,
  sectorId: null, industryLabel: "", rps20: null, rps50: 90, rps120: null, rps250: null, rpsDelta: null,
  inLivePool: false, elite: false, newHigh: false, ...patch });
function books(symbols = ["NVDA"]) {
  const value = bookCache();
  value.computedAt = "2026-09-25T21:00:00Z";
  value.books = ["2h", "4h"].map((tf) => ({ ...value.books[0], tf: tf as "2h" | "4h",
    view: { ...value.books[0].view, asOf: "2026-09-25T20:00:00Z", rows: symbols.map((symbol) => ({ symbol, entryPrice: 100, floatPnlPct: 1, weightPct: 10, rps: 90 })) } }));
  return value;
}
function captured(symbol = "NVDA", time = signalTime, event: "buy" | "sell" = "buy") {
  const payload: AlertPayload = { event, symbol, tf: "120", kind: 1, price: 100, strategyKey: `test-${symbol}`, entrySignalTime: time, barTime: time };
  return { version: 1, id: tradeIdOf(payload)!, payload, capturedAt: new Date(time + 1000).toISOString() };
}
function journalSignal(symbol = "NVDA", time = signalTime): JournalSignal {
  const raw = captured(symbol, time);
  return { id: raw.id, symbol, tf: "2h", date: new Date(time).toISOString().slice(0, 10), signalTime: time, capturedAt: raw.capturedAt,
    price: 100, quality: { version: "quality-v5", points: 80, available: 100, complete: true, label: "优秀", dimensions: [] },
    source: "live", sector: null, context: null,
    outcomes: { t1: { date: null, value: null, status: "pending" }, t3: { date: null, value: null, status: "pending" }, t5: { date: null, value: null, status: "pending" } }, excursions: [] };
}
const journal = (signals: JournalSignal[] = []): JournalArchive => ({ version: 1, asOf: "2026-09-25", builtAt: "2026-09-25T22:00:00Z", signals });
function loaders(patch: Partial<CatalystUniverseLoaders> = {}): CatalystUniverseLoaders {
  return { books: async () => books(), opportunity: async () => ({ ...emptyOpportunity(), asOf: "2026-09-25", universe: [stock("NVDA", { sectorId: "TECH", industryLabel: "信息技术｜半导体" })], leaders: ["TECH"] }),
    journal: async () => journal(), localSignals: async () => ({ records: [], available: true, partial: false, detail: "fixture" }), ...patch };
}
const event = (patch: Partial<EventInput> = {}): EventInput => ({ provider: "test", externalId: "1", sourceName: "fixture", sourceUrl: "https://example.com/news",
  title: "Published event", excerpt: "", type: "Corporate", importance: "medium", symbols: [], sectorIds: [], scope: "stock", publishedAt: "2026-09-25T17:00:00Z",
  eventAt: null, eventDate: "2026-09-25", timePrecision: "minute", session: "regular", timing: "confirmed", status: "published", sourceUpdatedAt: null, ...patch });

describe("Catalyst 自动对象关联", () => {
  it("同一股票合并两周期持仓、真实买点与机会关系，保留实际数据日期", async () => {
    const result = await loadCatalystUniverse(now, loaders({ journal: async () => journal([journalSignal()]), localSignals: async () => ({ records: [captured()], available: true, partial: false, detail: "fixture" }) }));
    expect(result.symbols).toHaveLength(1);
    const row = result.symbols[0];
    expect(row.relations.map((relation) => relation.kind)).toEqual(["portfolio", "portfolio", "signal", "opportunity"]);
    expect(row.relations[0]).toMatchObject({ tf: "2h", asOf: "2026-09-25T20:00:00Z", observedAt: now.toISOString() });
    expect(row.industry).toBe("信息技术｜半导体");
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].capturedAt).toBe(captured().capturedAt);
    expect(result.sectors).toHaveLength(11);
    expect(result.sectors.find((sector) => sector.id === "TECH")).toMatchObject({ etf: "XLK", leader: true });
    const relations = associateEvent(event({ symbols: ["NASDAQ:NVDA", "NVDA"] }), result);
    expect(relations).toEqual(row.relations);
    expect(relations[0].observedAt).not.toBe(event().publishedAt);
  });

  it("失败与已确认空持仓分开，其他源仍可独立保留", async () => {
    const result = await loadCatalystUniverse(now, loaders({ books: async () => { throw new Error("unavailable"); }, journal: async () => null,
      localSignals: async () => ({ records: [], available: false, partial: false, detail: "本地目录缺失" }) }));
    expect(result.symbols[0].relations.map((relation) => relation.kind)).toEqual(["opportunity"]);
    expect(result.health.filter((source) => source.id.startsWith("portfolio-")).every((source) => source.state === "unavailable")).toBe(true);
    expect(result.health.find((source) => source.id === "signal-journal")?.state).toBe("unavailable");
    const empty = await loadCatalystUniverse(now, loaders({ books: async () => books([]) }));
    expect(empty.health.find((source) => source.id === "portfolio-2h")).toMatchObject({ state: "ok", count: 0 });
  });

  it("近10天只保留及时捕获的真实买卖点，排除回放、未来、超期与损坏身份", async () => {
    const buy = captured("NVDA");
    const sell = captured("NVDA");
    sell.payload = { ...sell.payload, event: "sell", barTime: signalTime + 3600_000 };
    sell.capturedAt = new Date(signalTime + 3600_001).toISOString();
    const replay = { ...captured("REPLAY"), candidate: { replay: true } };
    const lagged = { ...captured("LAG"), capturedAt: new Date(signalTime + 16 * 60_000).toISOString() };
    const result = await loadCatalystUniverse(now, loaders({ journal: async () => journal([
      journalSignal(), { ...journalSignal("OLD", signalTime - 11 * 86_400_000) },
      { ...journalSignal("REPLAY"), source: "replay" }, journalSignal("FUTURE", now.getTime() + 1000),
    ]), localSignals: async () => ({ records: [buy, sell, replay, lagged, { ...captured("BAD"), id: "broken" }, captured("FUTURE", now.getTime() + 1)], available: true, partial: false, detail: "fixture" }) }));
    expect(result.signals.map((signal) => signal.event)).toEqual(["sell", "buy"]);
    expect(result.signals.every((signal) => signal.symbol === "NVDA")).toBe(true);
    expect(result.health.find((source) => source.id === "signal-live-archive")?.state).toBe("partial");
  });

  it("超过250观察上限时明确部分覆盖，并优先保留持仓与信号", async () => {
    const opportunities = Array.from({ length: 260 }, (_, i) => stock(`S${i}`, { rps50: 100 - i / 20 }));
    const holdings = Array.from({ length: 110 }, (_, i) => `H${i}`);
    const result = await loadCatalystUniverse(now, loaders({ books: async () => books(holdings), journal: async () => journal([journalSignal("SIGNAL")]),
      opportunity: async () => ({ ...emptyOpportunity(), asOf: "2026-09-25", universe: [...opportunities, stock("LOW", { rps50: 79 }), stock("ELITE", { rps50: 1, elite: true })], candidates: [stock("CANDIDATE", { rps50: 70 })] }) }));
    expect(result.symbols).toHaveLength(250);
    expect(result.symbols.slice(0, 110).map((row) => row.symbol)).toEqual(holdings);
    expect(result.symbols[110].symbol).toBe("SIGNAL");
    expect(result.symbols.some((row) => row.symbol === "LOW")).toBe(false);
    expect(result.symbols.some((row) => row.symbol === "ELITE")).toBe(true);
    expect(result.health.find((source) => source.id === "opportunity")).toMatchObject({ state: "partial", count: 250 });
    expect(result.health.find((source) => source.id === "universe-limit")?.state).toBe("partial");
  });
  it("完整纳入超过原100只上限的机会观察池", async () => {
    const opportunities = Array.from({ length: 130 }, (_, i) => stock(`S${i}`, { rps50: 90 }));
    const result = await loadCatalystUniverse(now, loaders({ opportunity: async () => ({ ...emptyOpportunity(), asOf: "2026-09-25", universe: opportunities }) }));
    expect(result.symbols.filter(row => row.relations.some(relation => relation.kind === "opportunity"))).toHaveLength(130);
    expect(result.health.find(source => source.id === "opportunity")).toMatchObject({ state: "ok", count: 130 });
  });

  it("明确候选可低于80，低强度非候选不关联；行业未知保持未知", async () => {
    const result = await loadCatalystUniverse(now, loaders({ books: async () => books(["UNKNOWN", "TECHONLY", "AAOI"]),
      opportunity: async () => ({ ...emptyOpportunity(), asOf: "2026-09-25", candidates: [stock("CANDIDATE", { rps50: 50 })], universe: [stock("LOW", { rps50: 79 }), stock("TECHONLY", { sectorId: "TECH", rps50: 10 })] }) }));
    expect(result.symbols.find((row) => row.symbol === "CANDIDATE")?.relations[0].kind).toBe("opportunity");
    expect(result.symbols.find((row) => row.symbol === "LOW")).toBeUndefined();
    expect(result.symbols.find((row) => row.symbol === "UNKNOWN")).toMatchObject({ sectorId: null, industry: null });
    expect(result.symbols.find((row) => row.symbol === "TECHONLY")).toMatchObject({ sectorId: "TECH", industry: null });
    expect(result.symbols.find((row) => row.symbol === "AAOI")?.industry).not.toContain("半导体");
  });

  it("行业事件只按显式板块关联重点板块与对象，市场事件标为市场", async () => {
    const result = await loadCatalystUniverse(now, loaders());
    const sector = associateEvent(event({ scope: "sector", sectorIds: ["TECH"] }), result);
    expect(sector.map((relation) => relation.kind)).toEqual(["sector", "portfolio", "portfolio", "opportunity"]);
    expect(associateEvent(event({ scope: "sector", sectorIds: ["ENERGY"] }), result)).toEqual([]);
    expect(associateEvent(event({ title: "Semiconductor industry news", scope: "sector", sectorIds: [] }), result)).toEqual([]);
    expect(associateEvent(event({ scope: "market" }), result)).toEqual([{ kind: "market", key: "market:US", label: "美国市场", asOf: "2026-09-25", observedAt: now.toISOString() }]);
  });

  it("未来生成的来源不进入当前对象；不会从固定行业表伪造领涨状态", async () => {
    const futureBooks = books(); futureBooks.computedAt = "2026-09-27T00:00:00Z";
    const result = await loadCatalystUniverse(now, loaders({ books: async () => futureBooks,
      opportunity: async () => ({ ...emptyOpportunity(), asOf: "2026-09-27", leaders: ["TECH"], universe: [stock("NVDA")] }),
      journal: async () => ({ ...journal([journalSignal()]), builtAt: "2026-09-27T00:00:00Z" }) }));
    expect(result.symbols).toEqual([]);
    expect(result.signals).toEqual([]);
    expect(result.sectors.some((sector) => sector.leader)).toBe(false);
    expect(result.health.find((source) => source.id === "opportunity")?.state).toBe("unavailable");
  });

  it("单个周期缺失、机会源抛错与部分损坏信号分别披露，不影响其他关系", async () => {
    const oneBook = books(); oneBook.books = oneBook.books.filter((book) => book.tf === "4h");
    const result = await loadCatalystUniverse(now, loaders({ books: async () => oneBook,
      opportunity: () => { throw new Error("source failed"); },
      journal: async () => journal([journalSignal(), { ...journalSignal("BAD"), id: "invalid" }]) }));
    expect(result.health.find((source) => source.id === "portfolio-2h")?.state).toBe("unavailable");
    expect(result.health.find((source) => source.id === "portfolio-4h")?.state).toBe("ok");
    expect(result.health.find((source) => source.id === "opportunity")?.state).toBe("unavailable");
    expect(result.health.find((source) => source.id === "signal-journal")).toMatchObject({ state: "partial", count: 1 });
    expect(result.symbols[0].relations.map((relation) => relation.kind)).toEqual(["portfolio", "signal"]);
  });

  it("行业关系保留Opportunity自身日期，不借用较新的持仓日期", async () => {
    const source = await loaders().opportunity(); source.asOf = "2026-09-24";
    const result = await loadCatalystUniverse(now, loaders({ opportunity: async () => source }));
    expect(result.asOf).toBe("2026-09-25");
    expect(result.sectors.find((sector) => sector.id === "TECH")?.asOf).toBe("2026-09-24");
    expect(associateEvent(event({ scope: "sector", sectorIds: ["TECH"] }), result)[0].asOf).toBe("2026-09-24");
    const legacy = { ...result, sectors: result.sectors.map(({ asOf: _asOf, ...sector }) => sector) };
    expect(associateEvent(event({ scope: "sector", sectorIds: ["TECH"] }), legacy)[0].asOf).toBe("2026-09-25");
  });

  it("个股新闻的显式领涨行业标签可供筛选，但不扩散为同行持仓关系", async () => {
    const source = await loaders().opportunity();
    source.universe.push(stock("AMD", { sectorId: "TECH", industryLabel: "半导体" }));
    const result = await loadCatalystUniverse(now, loaders({ books: async () => books(["NVDA", "AMD"]), opportunity: async () => source }));
    const relations = associateEvent(event({ symbols: ["NVDA"], sectorIds: ["TECH"] }), result);
    expect(relations.some((relation) => relation.kind === "sector" && relation.key === "sector:TECH")).toBe(true);
    expect(relations.some((relation) => relation.key.includes("AMD"))).toBe(false);
    expect(associateEvent(event({ sectorIds: ["ENERGY"] }), result)).toEqual([]);
  });
});
