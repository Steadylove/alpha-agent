import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CatalystToday, CatalystTomorrow } from "@/components/review/CatalystBrief";
import { TomorrowMap } from "@/components/review/TomorrowMap";
import { DailyReview as DailyReviewPage } from "@/components/review/DailyReview";
import type { CatalystBriefItem, CatalystReviewDigest, CatalystReviewView } from "@/lib/catalyst/reviewDigest";
import type { DailyReview } from "@/lib/review/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => { vi.unstubAllGlobals(); });

function item(overrides: Partial<CatalystBriefItem> = {}): CatalystBriefItem {
  return { id: "event-a", subject: "AMD", title: "公司公布经营结果", kind: "company", relation: "Portfolio", sourceUrl: "https://example.com/release?one=1&two=2", eventDate: "2026-09-25", timeLabel: "09-25 10:00 ET", priceChange: 2.5, rpsChange: 0, sectorRpsChange: null, ...overrides };
}
function digest(): CatalystReviewDigest {
  return { version: 1, reviewDate: "2026-09-25", reviewBuiltAt: "2026-09-26T00:00:00.000Z", capturedAt: "2026-09-26T02:00:00.000Z", status: "ready",
    today: [item(), item({ id: "sector", subject: "半导体", title: "行业政策公布", kind: "sector", relation: "Sector", priceChange: null, rpsChange: 777, sectorRpsChange: -3.25 })],
    upcoming: [item({ id: "calendar", subject: "CPI", title: "Consumer Price Index", kind: "upcoming", relation: "Market", eventDate: "2026-09-28", timeLabel: "09-28 08:30 ET", priceChange: null, rpsChange: null, sectorRpsChange: null })], warnings: [],
  };
}
const view = (value = digest()): CatalystReviewView => ({ status: "ready", digest: value });
const renderToday = (catalyst?: CatalystReviewView) => renderToStaticMarkup(createElement(CatalystToday, { catalyst }));
const renderTomorrow = (catalyst?: CatalystReviewView) => renderToStaticMarkup(createElement(CatalystTomorrow, { catalyst }));
const renderWrapped = (element: ReactElement) => renderToStaticMarkup(createElement(MantineProvider, null, element));
function review(): DailyReview {
  return { version: 1, date: "2026-09-25", previousDate: "2026-09-24", builtAt: "2026-09-26T00:00:00.000Z",
    market: { regime: "Neutral", summary: "市场状态保持独立", metrics: [{ symbol: "SPY", today: 100, yesterday: 100, change: 0 }], breadth: { today: 50, yesterday: 50, total: 503, valid: 503, universe: "SP500", membershipAsOf: "2026-09-25" }, strongSectors: { today: 5, yesterday: 5, total: 11 } },
    options: [], sectors: [], signals: [], accounts: [], warnings: [],
    tomorrow: { version: "tomorrow-v1", date: "2026-09-25", targetDate: "2026-09-28", basis: "published", publishedAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", revision: 1,
      events: Array.from({ length: 5 }, (_, i) => ({ id: `watch-${i}`, domain: "market", group: "market", source: "market", symbols: ["SPY"], title: `原观察事件 ${i + 1}`, evidence: `原依据 ${i + 1}`, focus: `原观察重点 ${i + 1}`, priority: 100 - i })),
      candidateCount: 5, notes: ["原规则备注"], observations: [{ eventId: "previous", title: "原历史观察", text: "原历史对照结果", status: "observed" }], history: [] },
  };
}

describe("compact saved Catalyst Today", () => {
  it("shows saved source-linked facts, exact zero and missing data without mixing sector RPS metrics", () => {
    const html = renderToday(view());
    expect(html).toContain('id="catalyst-today"'); expect(html).toContain("Catalyst Today");
    expect(html).toContain("公司公布经营结果"); expect(html).toContain("Portfolio"); expect(html).toContain("模型持仓");
    expect(html).toContain("+2.50%"); expect(html).toContain("0.00 pt");
    expect(html).toContain("板块 RPS Δ"); expect(html).toContain("-3.25 pt"); expect(html).not.toContain("777");
    expect(html).toContain("—");
    expect(html).toContain("Price：该交易日 T0 收盘相对前收盘变化");
    expect(html).toContain("包含公告前波动，不代表即时影响或因果");
    expect(html).toContain('href="https://example.com/release?one=1&amp;two=2"');
    expect(html).toContain('rel="noopener noreferrer"'); expect(html).toContain('href="/catalyst"');
  });
  it("labels the ET supplement capture separately from the original review publication", () => {
    const html = renderToday(view());
    expect(html).toContain("2026-09-25 复盘补充"); expect(html).toContain("非原发布时间");
    expect(html).toContain("2026/09/25 22:00 ET");
    expect(html).toMatch(/datetime="2026-09-26T02:00:00.000Z"/i);
    expect(html).toContain("不代表原复盘发布时已知");
    expect(html).not.toContain("2026/09/26 02:00 ET");
  });
  it("caps Today at three entries and avoids price metrics for its upcoming calendar item", () => {
    const value = digest();
    value.today = [item(), item({ id: "b", subject: "NVDA", title: "第二条" }), item({ id: "c", subject: "FOMC", title: "会议日程", kind: "upcoming", relation: "Market", priceChange: 999, rpsChange: 888 }), item({ id: "hidden", title: "隐藏第四条" })];
    const html = renderToday(view(value));
    expect(html).toContain("会议日程"); expect(html).toContain("未来日程");
    expect(html).not.toContain("隐藏第四条"); expect(html).not.toContain("999"); expect(html).not.toContain("888");
    expect(html.match(/Price · T0/g)).toHaveLength(2);
  });
  it("keeps absent, failed, partial and complete-zero coverage semantically distinct", () => {
    const missing = renderToday();
    expect(missing).toContain("尚无事件补充留档"); expect(missing).not.toContain("No Material Catalyst");
    const failure = renderToday({ status: "unavailable", digest: digest() });
    expect(failure).toContain("暂不可用"); expect(failure).not.toContain("公司公布经营结果"); expect(failure).not.toContain("No Material Catalyst");
    const partial = digest(); partial.status = "partial"; partial.today = []; partial.warnings = ["公司新闻来源暂不可用"];
    const partialHtml = renderToday(view(partial));
    expect(partialHtml).toContain("部分覆盖"); expect(partialHtml).toContain("仍有来源缺失"); expect(partialHtml).toContain("公司新闻来源暂不可用");
    expect(partialHtml).not.toContain("No Material Catalyst");
    const ready = digest(); ready.today = [];
    const readyHtml = renderToday(view(ready));
    expect(readyHtml).toContain("No Material Catalyst"); expect(readyHtml).toContain("在本次已覆盖的来源与关联对象中");
  });
  it("escapes all supplied copy and refuses unsafe source URLs", () => {
    const value = digest();
    value.today = [item({ subject: '<img src="x" onerror="x">', title: "<script>bad()</script>", sourceUrl: "javascript:alert(1)" })];
    value.warnings = ["<img src=x onerror=bad()>"];
    const html = renderToday(view(value));
    expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&lt;img"); expect(html).not.toContain("<script>"); expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:'); expect(html).toContain("来源链接不可用");
    value.today[0].sourceUrl = "https://user:secret@example.com/private";
    expect(renderToday(view(value))).not.toContain("user:secret");
    value.today[0].sourceUrl = "http://127.0.0.1/private";
    expect(renderToday(view(value))).not.toContain('href="http://127');
  });
});

describe("concise Tomorrow Events supplement", () => {
  it("renders schedules only, respects date-only precision and never repeats price/RPS values", () => {
    const value = digest();
    value.upcoming = [item({ id: "calendar", kind: "upcoming", subject: "AMD", title: "财报日程", timeLabel: "09-28 盘后（具体时间待确认）ET · 预计", priceChange: 123, rpsChange: 456, sectorRpsChange: 789 }), item({ id: "published", title: "不能混入的已发布新闻" })];
    const html = renderTomorrow(view(value));
    expect(html).toContain("Tomorrow Events"); expect(html).toContain("未来 72 小时"); expect(html).toContain("财报日程");
    expect(html).toContain("09-28 盘后（具体时间待确认）ET · 预计");
    expect(html).not.toContain("不能混入的已发布新闻"); expect(html).not.toContain("Price"); expect(html).not.toContain("RPS");
    expect(html).not.toContain("123"); expect(html).not.toContain("456"); expect(html).not.toContain("789");
    expect(html).toContain("按本次采集时刻计算"); expect(html).not.toContain("原观察清单独立保留");
  });
  it("caps upcoming entries at three without filling the page with news", () => {
    const value = digest(); value.upcoming = Array.from({ length: 5 }, (_, i) => item({ id: `future-${i}`, subject: "CPI", title: `日程-${i}`, kind: "upcoming" }));
    const html = renderTomorrow(view(value));
    expect(html).toContain("日程-2"); expect(html).not.toContain("日程-3"); expect(html).not.toContain("日程-4");
  });
  it("does not imply missing or partial calendar coverage means no future events", () => {
    expect(renderTomorrow()).not.toContain("No Material Catalyst");
    const value = digest(); value.status = "partial"; value.upcoming = [];
    expect(renderTomorrow(view(value))).toContain("仍有来源缺失");
    value.status = "ready";
    expect(renderTomorrow(view(value))).toContain("在本次已覆盖的日历与关联对象中");
  });
  it("preserves the original five watch events, rules and historical observations unchanged", () => {
    const r = review(), original = structuredClone(r.tomorrow);
    const html = renderWrapped(createElement(TomorrowMap, { review: r, catalyst: view() }));
    expect(r.tomorrow).toEqual(original);
    for (let i = 1; i <= 5; i++) { expect(html).toContain(`原观察事件 ${i}`); expect(html).toContain(`原观察重点 ${i}`); }
    expect(html).toContain("01 / Market Structure"); expect(html).toContain("02 / Portfolio &amp; Signal"); expect(html).toContain("03 / TOMORROW FOCUS");
    expect(html).toContain("新信号需完整评分且 ≥70"); expect(html).toContain("原规则备注"); expect(html).toContain("原历史对照结果");
    expect(html).toContain("Tomorrow Events"); expect(html).toContain("Consumer Price Index");
  });
  it("can show saved schedules independently when the original Tomorrow Map is absent", () => {
    const r = review(); delete r.tomorrow;
    const html = renderWrapped(createElement(TomorrowMap, { review: r, catalyst: view() }));
    expect(html).toContain("等待收盘任务生成下一交易日观察清单"); expect(html).toContain("Consumer Price Index");
  });
});

describe("Daily Review integration and compact layout", () => {
  it("adds an unnumbered anchor after market state while preserving original section numbering", () => {
    const html = renderWrapped(createElement(DailyReviewPage, { review: review(), dates: ["2026-09-25"], journal: [], error: null, catalyst: view() }));
    expect(html).toContain('href="#catalyst-today"');
    expect(html.indexOf('id="market"')).toBeLessThan(html.indexOf('id="catalyst-today"'));
    expect(html.indexOf('id="catalyst-today"')).toBeLessThan(html.indexOf('id="options"'));
    for (const id of ["options", "sectors", "signals", "accounts", "journal", "tomorrow", "analysis"]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/id="options"[\s\S]*?>02<\/span>/);
    expect(html).toMatch(/id="tomorrow"[\s\S]*?>07<\/span>/);
    expect(html).toMatch(/id="analysis"[\s\S]*?>08<\/span>/);
  });
  it("uses only supplied saved data during render", () => {
    const fetcher = vi.fn(() => { throw new Error("Rendering must not fetch"); }); vi.stubGlobal("fetch", fetcher);
    renderToday(view()); renderTomorrow(view()); expect(fetcher).not.toHaveBeenCalled();
  });
  it("provides wrapping, a single-column mobile layout, and 44px link/disclosure targets", () => {
    const css = readFileSync("src/components/review/catalystBrief.module.css", "utf8");
    expect(css).toContain("overflow-wrap: anywhere"); expect(css).toContain("min-height: 44px");
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.todayItems\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*\.schedule > li\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toContain(":focus-visible");
    expect(css).toContain("-webkit-line-clamp: 3");
    const value = digest(); value.today[0].title = "A detailed official announcement ".repeat(12);
    expect(renderToday(view(value))).toContain(`aria-label="AMD：${value.today[0].title}，查看来源（新窗口）"`);
  });
});
