import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CatalystMonitor, eventTimeLabel, selectCatalystEvents, type CatalystFilters } from "@/components/catalyst/CatalystMonitor";
import type { CatalystEvent, CatalystReport, EventReaction, Relation } from "@/lib/catalyst/types";

const cutoff = "2026-09-26T02:00:00.000Z"; // September 25, 22:00 ET.
const sessions = ["2026-09-16", "2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29"];
const relation = (kind: Relation["kind"], label = "AMD"): Relation => ({ kind, key: `${kind}/AMD`, label, tf: kind === "portfolio" ? "2h" : undefined, asOf: "2026-09-25", observedAt: cutoff });
const event = (overrides: Partial<CatalystEvent> = {}): CatalystEvent => ({
  id: "event-one", provider: "fixture", externalId: "1", sourceName: "官方来源", sourceUrl: "https://example.com/release",
  title: "公司发布已确认的业务公告", excerpt: "公告正文的事实摘要。", type: "Corporate", importance: "high", symbols: ["AMD"], sectorIds: ["TECH"], scope: "stock",
  publishedAt: "2026-09-25T14:00:00.000Z", eventAt: "2026-09-25T14:00:00.000Z", eventDate: "2026-09-25", timePrecision: "minute", session: "regular", timing: "confirmed", status: "published", sourceUpdatedAt: null,
  firstSeenAt: "2026-09-25T14:10:00.000Z", lastSeenAt: cutoff, revision: 1, backfilled: false,
  firstRelations: [relation("signal")], currentRelations: [relation("portfolio")], relatedSourceUrls: [], ...overrides,
});
const filters: CatalystFilters = { category: "all", range: "3d", importance: "all" };
const reaction = (): EventReaction => ({
  eventId: "event-one", symbol: "AMD", asOf: "2026-09-25", anchorDate: "2026-09-25", baseline: { date: "2026-09-24", close: 100 }, basis: "共同基准，不作事件因果归因。",
  price: { t0: { date: "2026-09-25", value: 2.5, status: "ready" }, t1: { date: "2026-09-28", value: null, status: "pending" }, t3: { date: "2026-09-30", value: null, status: "missing" }, t5: { date: "2026-10-02", value: null, status: "unavailable" } },
  rps: { metric: "composite-daily-sp500-v1", before: { date: "2026-09-24", value: 80, status: "ready" }, after: { date: "2026-09-25", value: 82, status: "ready" } },
  sector: { metric: "sector-etf-20d-excess-spy-v1", etf: "XLK", before: { date: "2026-09-24", value: 1, status: "ready" }, after: { date: "2026-09-25", value: 1.2, status: "ready" } },
  mfe: { date: "2026-10-02", value: null, status: "pending" }, mae: { date: "2026-10-02", value: null, status: "pending" },
  signalsAfter: [{ id: "signal-one", symbol: "AMD", tf: "2h", event: "buy", signalTime: "2026-09-25T15:30:00.000Z", capturedAt: "2026-09-25T15:30:01.000Z" }],
});
const report = (): CatalystReport => ({
  version: 1, generatedAt: cutoff, asOf: "2026-09-25", sessions,
  universe: { asOf: "2026-09-25", observedAt: cutoff, symbols: [], sectors: [], signals: [], health: [] },
  sources: [{ id: "official", label: "官方日历", state: "ok", checkedAt: cutoff, count: 1, detail: "日历已读取" }, { id: "earnings", label: "财报来源", state: "disabled", checkedAt: cutoff, count: 0, detail: "未启用，不能判断财报覆盖" }],
  events: [event()], reactions: [reaction()], summary: { generatedAt: cutoff, inputHash: "hash", model: "deepseek", sentences: [{ text: "本次收录一条与模型持仓相关的公司公告。", eventIds: ["event-one"] }] }, summaryStatus: "ready", warnings: [],
});
const render = (value: CatalystReport | null, stale = false, error: string | null = null) => renderToStaticMarkup(createElement(CatalystMonitor, { report: value, stale, error }));

describe("Catalyst event time filters", () => {
  it("uses the ET collection day, not UTC, for Today and never leaks future publications", () => {
    const late = event({ id: "late", publishedAt: "2026-09-26T01:30:00.000Z" });
    const tomorrow = event({ id: "future", publishedAt: "2026-09-26T03:00:00.000Z" });
    const old = event({ id: "prior", publishedAt: "2026-09-25T03:30:00.000Z" });
    expect(selectCatalystEvents([late, tomorrow, old], { ...filters, range: "today" }, cutoff, sessions).map(e => e.id)).toEqual(["late"]);
  });
  it("applies exact rolling 24 hours and excludes unknown timestamps", () => {
    const atBoundary = event({ id: "boundary", publishedAt: "2026-09-25T02:00:00.000Z" });
    const before = event({ id: "old", publishedAt: "2026-09-25T01:59:59.000Z" });
    const dateOnly = event({ id: "date", publishedAt: null, eventAt: null, timePrecision: "date" });
    expect(selectCatalystEvents([atBoundary, before, dateOnly], { ...filters, range: "24h" }, cutoff, sessions).map(e => e.id)).toEqual(["boundary"]);
  });
  it("uses supplied exchange sessions around holidays instead of subtracting calendar days", () => {
    const holidaySessions = ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-08"];
    const rows = [event({ id: "thursday", publishedAt: "2026-09-03T15:00:00Z" }), event({ id: "wednesday", publishedAt: "2026-09-02T15:00:00Z" }), event({ id: "weekend", publishedAt: "2026-09-06T15:00:00Z" })];
    const result = selectCatalystEvents(rows, filters, "2026-09-08T20:00:00Z", holidaySessions).map(e => e.id);
    expect(result).toContain("thursday");
    expect(result).toContain("weekend");
    expect(result).not.toContain("wednesday");
    expect(selectCatalystEvents(rows, filters, cutoff, [])).toEqual([]);
  });
  it("uses current relations for filters, preserves importance and sorts portfolio before market", () => {
    const market = event({ id: "market", currentRelations: [relation("market")] });
    const held = event({ id: "held", importance: "low", currentRelations: [relation("portfolio")] });
    expect(selectCatalystEvents([market, held], filters, cutoff, sessions).map(e => e.id)).toEqual(["held", "market"]);
    expect(selectCatalystEvents([market, held], { ...filters, category: "portfolio", importance: "high" }, cutoff, sessions)).toEqual([]);
    expect(selectCatalystEvents([held], { ...filters, category: "signal" }, cutoff, sessions)).toEqual([]);
  });
  it("keeps calendar independent of retrospective range with exact 72h boundaries and no cancelled events", () => {
    const scheduled = event({ id: "boundary", status: "scheduled", eventDate: "2026-09-28", eventAt: "2026-09-29T02:00:00Z" });
    const later = event({ ...scheduled, id: "later", eventAt: "2026-09-29T02:00:01Z" });
    const cancelled = event({ ...scheduled, id: "cancelled", status: "cancelled" });
    const dateOnly = event({ ...scheduled, id: "date", eventAt: null, eventDate: "2026-09-28", timePrecision: "date" });
    expect(selectCatalystEvents([scheduled, later, cancelled, dateOnly], { ...filters, range: "today" }, cutoff, sessions, true).map(e => e.id).sort()).toEqual(["boundary", "date"]);
    expect(selectCatalystEvents([scheduled], filters, cutoff, sessions)).toEqual([]);
  });
  it("does not invent clock times for date-only and after-close events", () => {
    expect(eventTimeLabel(event({ eventAt: null, timePrecision: "date" }))).toBe("2026-09-25 · 具体时间待确认 · ET");
    expect(eventTimeLabel(event({ eventAt: null, timePrecision: "session", session: "after" }))).toBe("2026-09-25 · 盘后 · ET");
  });
});

describe("Catalyst read-only page", () => {
  it("shows saved evidence, daily windows, model-account relations and unavailable states distinctly", () => {
    const html = render(report());
    expect(html).toContain("Catalyst Monitor");
    expect(html).toContain("本次收录一条与模型持仓相关的公司公告。");
    expect(html).toContain("2026/09/25 22:00 ET");
    expect(html).toContain("+2.50%");
    expect(html).toContain("待成熟");
    expect(html).toContain("缺数据");
    expect(html).toContain("来源不可用");
    expect(html).toContain("不是板块 RPS");
    expect(html).toContain("+1.20 pp");
    expect(html).toContain("历史日线与当日标尺重建");
    expect(html).toContain("排除 T0");
    expect(html).toContain("首次关联 · 已冻结");
    expect(html).toContain("模型持仓");
    expect(html).toContain("系统信号");
    expect(html).toContain("未启用，不能判断财报覆盖");
    expect(html).toContain('href="https://example.com/release"');
    expect(html).toContain("公告前的价格变化");
    expect(html).toContain("真实信号");
  });
  it("hides stale summary text while retaining original facts and archive timestamps", () => {
    const value = report(); value.summaryStatus = "stale";
    const html = render(value, true);
    expect(html).not.toContain("本次收录一条与模型持仓相关的公司公告。");
    expect(html).toContain("上一版摘要不再展示");
    expect(html).toContain("当前为上次采集的留档");
    expect(html).toContain("公司发布已确认的业务公告");
  });
  it("renders untrusted texts escaped and refuses non-web source links", () => {
    const value = report(); value.events[0].title = '<script>alert("event")</script>'; value.events[0].sourceUrl = "javascript:alert(1)";
    value.summary!.sentences[0].text = '<img src="x" onerror="alert(1)">';
    const html = render(value);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("来源链接不可用");
  });
  it("explains missing archives and empty source coverage without claiming no catalyst exists", () => {
    const absent = render(null, false, "归档尚未生成");
    expect(absent).toContain("等待事件数据归档");
    expect(absent).toContain("归档尚未生成");
    expect(absent).not.toContain("本次收录一条");
    const value = report(); value.events = []; value.reactions = []; value.summary = null; value.summaryStatus = "not-requested";
    const empty = render(value);
    expect(empty).toContain("空列表不代表没有事件");
    expect(empty).toContain("来源未启用、采集缺失与没有重要事件是不同状态");
    expect(empty).not.toContain("No Material Catalyst");
    expect(empty).toContain("刷新页面不会触发采集或模型调用");
  });
  it("limits initial event and reaction cards while retaining complete counts and direct source links", () => {
    const value = report(); value.summary = null; value.summaryStatus = "not-requested";
    value.events = Array.from({ length: 15 }, (_, i) => event({ id: `case-${i}`, title: `Company event ${i}`, sourceUrl: `https://example.com/release-${i}` }));
    value.reactions = Array.from({ length: 9 }, (_, i) => ({ ...reaction(), eventId: `case-${14 - i}`, symbol: `STOCK${i}` }));
    const html = render(value);
    expect(html.match(/id="event-case-/g)).toHaveLength(12);
    expect(html).not.toContain('id="event-case-14"');
    expect(html).toContain("已展示 12 / 15 条事件");
    expect(html).toContain("已展示 6 / 9 个反应记录");
    expect(html).toContain("再看 12 条事件");
    expect(html).toContain("再看 6 个反应记录");
    expect(html).toContain("STOCK5");
    expect(html).not.toContain("STOCK6");
    expect(html).toContain('href="https://example.com/release-14"');
    expect(html).not.toContain('href="#event-case-14"');
  });
  it("includes the full monitored symbol list even when no related events were collected", () => {
    const value = report(); value.events = []; value.reactions = []; value.summary = null;
    value.universe.symbols = [{ symbol: "NVDA", name: "NVIDIA Corporation", sectorId: "TECH", industry: "半导体", relations: [relation("portfolio", "NVDA 模型持仓")] }];
    value.universe.sectors = [{ id: "TECH", name: "信息技术", etf: "XLK", leader: true }];
    const html = render(value);
    expect(html).toContain("查看全部监测标的");
    expect(html).toContain("包含尚无事件的标的");
    expect(html).toContain('href="/desk?q=NVDA"');
    expect(html).toContain("NVIDIA Corporation");
    expect(html).toContain("信息技术 · 半导体");
    expect(html).toContain("NVDA 模型持仓");
    expect(html).toContain("完整对象快照，不受上方事件筛选影响");
  });
});
