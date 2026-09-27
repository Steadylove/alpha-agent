import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextBrief } from "@/components/context/ContextBrief";
import { FlowContextLink } from "@/components/context/ContextLinks";
import { SymbolContext } from "@/components/context/SymbolContext";
import { DailyReview } from "@/components/review/DailyReview";
import type { ContextObservation, ContextReport } from "@/lib/context/types";
import type { DailyReview as Review } from "@/lib/review/types";
import type { CatalystReviewView } from "@/lib/catalyst/reviewDigest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => { vi.unstubAllGlobals(); });
const at = "2026-09-26T02:00:00.000Z";
function observation(symbol = "AMD"): ContextObservation {
  return {
    symbol, state: "event-flow", stateLabel: "事件与异常流同窗口出现", summary: `${symbol} 已收录事件与来源报道并列观察，不作因果判断。`,
    events: [{ id: "event-a", title: "公司公布经营进展", type: "Corporate", sourceUrl: "https://example.com/release", publishedAt: "2026-09-25T14:00:00.000Z", firstSeenAt: "2026-09-25T14:05:00.000Z", updatedAt: null, eventDate: "2026-09-25", anchorDate: "2026-09-25", timePrecision: "minute", importance: "high", revision: 1 }],
    flows: [{ id: "flow-a", sourceUrl: "https://example.com/flow", postedAt: "2026-09-25T15:00:00.000Z", firstObservedAt: null, updatedAt: null, anchorDate: "2026-09-25", right: "put", side: "seller", direction: "bull", premium: 250000, strike: 120, expiry: "2026-10-16", provenanceStatus: "legacy-unknown", revision: null, evidenceHash: null, flags: ["首次观察时间未留档"] }],
    associations: [{ eventId: "event-a", flowId: "flow-a", sessionDistance: 0, window: "short" }],
    trend: { status: "observed", label: "已收录 2H 信号与当前模型持仓", signals: [{ id: "signal-a", tf: "2h", event: "buy", signalTime: "2026-09-25T14:30:00.000Z", capturedAt: "2026-09-25T14:31:00.000Z", eventLinks: [{ eventId: "event-a", knowledge: "observed-after-signal" }], flowLinks: [{ flowId: "flow-a", knowledge: "unknown" }] }], holdings: [{ tf: "2h", asOf: "2026-09-25", observedAt: at, label: "当前模型持仓快照" }], rps: { metric: "composite-daily-sp500-v1", value: 82, asOf: "2026-09-25", basis: "日线重建；非实时排名" } },
    timeline: [{ id: "event:event-a", track: "event", at: "2026-09-25T14:00:00.000Z", observedAt: "2026-09-25T14:05:00.000Z", title: "公司公布经营进展", timeBasis: "来源发布时间", sourceUrl: "https://example.com/release" }, { id: "flow:flow-a", track: "flow", at: "2026-09-25T15:00:00.000Z", observedAt: null, title: "Sell Put", timeBasis: "来源报道时间", sourceUrl: "https://example.com/flow" }],
    warnings: ["来源不是完整市场成交带"],
  };
}
function report(): ContextReport {
  const row = observation();
  return { version: 1, ruleVersion: "context-observation-v1", asOf: "2026-09-25", cutoff: at, generatedAt: "2026-09-26T03:00:00.000Z", sampleLabel: "非完整市场样本，仅用于辅助观察",
    coverage: { events: { state: "partial", checkedAt: at, detail: "公告来源部分覆盖" }, flow: { state: "partial", checkedAt: at, detail: "来源有采集缺口", from: "2026-09-21", through: "2026-09-25" }, signals: { state: "ok", checkedAt: at, detail: "只覆盖近十日实收范围" } }, observations: [row], highlights: [row], summary: { generatedAt: at, model: "deepseek", inputHash: "hash", sentences: [{ text: "AMD 事件与来源异常流在本次窗口内均有记录。", evidenceIds: ["event:event-a", "flow:flow-a"] }] }, summaryStatus: "ready", warnings: [] };
}
const renderBrief = (value: ContextReport) => renderToStaticMarkup(createElement(ContextBrief, { report: value }));
const renderDetail = (value: ContextReport | null, date = "2026-09-25") => renderToStaticMarkup(createElement(SymbolContext, { symbol: "AMD", date, context: value ? { report: value, observation: value.observations[0] } : null }));

describe("Context saved UI", () => {
  it("limits the home supplement to three observations and keeps all links on the saved date", () => {
    const value = report(); value.highlights = ["AMD", "NVDA", "MSFT", "HIDDEN"].map(observation); value.observations = value.highlights;
    const html = renderBrief(value);
    expect(html).toContain("Context Today"); expect(html).toContain("OPTIONS FLOW"); expect(html).toContain("Partial Market Sample");
    expect(html).toContain('href="/context/AMD?date=2026-09-25"'); expect(html).toContain('href="/context/MSFT?date=2026-09-25"');
    expect(html).not.toContain("HIDDEN"); expect(html).toContain("信息截至 2026/09/25 22:00 ET"); expect(html).toContain("生成于 2026/09/25 23:00 ET");
  });
  it("separates reported, observed and signal capture times from model holdings", () => {
    const html = renderDetail(report());
    expect(html).toContain('id="context-events"'); expect(html).toContain('id="context-flow"'); expect(html).toContain('id="context-trend"');
    expect(html).toContain("2026/09/25 10:00 ET"); expect(html).toContain("2026/09/25 10:05 ET");
    expect(html).toContain("系统首次观察 时间未留档"); expect(html).toContain("旧记录，首次观察信息不完整");
    expect(html).toContain("当前版本首次记录"); expect(html).toContain("归档版本"); expect(html).not.toContain("来源更新");
    expect(html).toContain("Sell Put"); expect(html).toContain("$250.0K"); expect(html).toContain("信号之后才知该版本");
    expect(html).toContain("关联异常流：信号时是否已知待确认");
    expect(html).toContain("信号不等于已执行交易"); expect(html).toContain("CURRENT MODEL"); expect(html).toContain("不能倒推事件发生时持仓");
    expect(html).toContain("相隔 0 个交易日"); expect(html).toContain("仅为时间关联");
  });
  it("links AI references to exact evidence anchors without exposing raw IDs as prose", () => {
    const html = renderDetail(report());
    expect(html).toContain('id="context-event:event-a"'); expect(html).toContain('id="context-flow:flow-a"');
    expect(html).toContain('href="/context/AMD?date=2026-09-25#context-event%3Aevent-a"');
    expect(html).toContain('href="/context/AMD?date=2026-09-25#context-flow%3Aflow-a"');
    expect(html).toContain("Event 1 ↗"); expect(html).not.toContain(">event:event-a<");
    const stale = report(); stale.summaryStatus = "stale";
    expect(renderDetail(stale)).not.toContain("AMD 事件与来源异常流在本次窗口内均有记录。");
  });
  it("does not substitute another date when a historic report is missing", () => {
    for (const html of [renderDetail(null, "2026-09-24"), renderDetail(report(), "2026-09-24")]) {
      expect(html).toContain("2026-09-24 尚无该标的可读取的 Context 留档"); expect(html).toContain("未用其他日期代替");
      expect(html).not.toContain("公司公布经营进展"); expect(html).toContain('href="/flow?date=2026-09-24"');
    }
    const link = renderToStaticMarkup(createElement(FlowContextLink, { symbol: "AMD", date: "2026-09-24", report: report(), brief: true }));
    expect(link).toContain('href="/context/AMD?date=2026-09-24"'); expect(link).not.toContain("公司公布经营进展");
  });
  it("keeps partial/empty observations honest and rejects unsafe source URLs", () => {
    const value = report(); value.observations[0].events = []; value.observations[0].flows = []; value.observations[0].trend = { status: "unknown", label: "趋势证据未确认", signals: [], holdings: [], rps: null }; value.summary = null;
    const html = renderDetail(value);
    expect(html).toContain("未收录不等于没有事件"); expect(html).toContain("不能据此认定全市场没有相关成交");
    expect(html).toContain("该日数据缺失；不采用其他日期排名"); expect(html).not.toContain("无异常成交");
    const unsafe = report(); unsafe.observations[0].events[0].sourceUrl = "javascript:alert(1)"; unsafe.observations[0].events[0].title = "<script>bad()</script>";
    const escaped = renderDetail(unsafe);
    expect(escaped).toContain("&lt;script&gt;"); expect(escaped).not.toContain("<script>"); expect(escaped).not.toContain('href="javascript:');
  });
  it("renders saved facts without fetches", () => {
    const fetcher = vi.fn(() => { throw new Error("Read-only render"); }); vi.stubGlobal("fetch", fetcher);
    renderBrief(report()); renderDetail(report()); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("home fallback and existing modules", () => {
  const review: Review = { version: 1, date: "2026-09-25", previousDate: "2026-09-24", builtAt: at,
    market: { regime: "Neutral", summary: "原市场状态", metrics: [], breadth: { today: 50, yesterday: 50, total: 503, valid: 503, universe: "SP500", membershipAsOf: "2026-09-25" }, strongSectors: { today: 5, yesterday: 5, total: 11 } }, options: [], sectors: [], signals: [], accounts: [], warnings: [] };
  const catalyst: CatalystReviewView = { status: "ready", digest: { version: 1, reviewDate: "2026-09-25", reviewBuiltAt: at, capturedAt: at, status: "ready", today: [], upcoming: [{ id: "calendar", subject: "CPI", title: "保留未来日程", kind: "upcoming", relation: "Market", sourceUrl: "https://example.com/calendar", eventDate: "2026-09-28", timeLabel: "仅日期，无具体时间", priceChange: null, rpsChange: null, sectorRpsChange: null }], warnings: [] } };
  const renderHome = (context: ContextReport | null) => renderToStaticMarkup(createElement(MantineProvider, null, createElement(DailyReview, { review, dates: [review.date], journal: [], error: null, context, catalyst })));
  it("uses same-date Context only and leaves the original Tomorrow Events and numbering intact", () => {
    const html = renderHome(report());
    expect(html).toContain("Context Today"); expect(html).not.toContain("Catalyst Today"); expect(html).toContain("保留未来日程"); expect(html).toContain("Tomorrow Events");
    for (const id of ["options", "sectors", "signals", "accounts", "journal", "tomorrow", "analysis"]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/id="tomorrow"[\s\S]*?>07<\/span>/);
    expect(renderHome(null)).toContain("Catalyst Today");
    const otherDate = report(); otherDate.asOf = "2026-09-24"; expect(renderHome(otherDate)).toContain("Catalyst Today");
  });
});
