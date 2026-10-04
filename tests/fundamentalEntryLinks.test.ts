import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DailyReview } from "@/components/review/DailyReview";
import { FundBoard, LiveBookCard, type FundSnapshot } from "@/components/FundBoard";
import { useFundamentalSummaries } from "@/components/fundamental/useFundamentalSummaries";
import type { DailyReview as Review, JournalSignal } from "@/lib/review/types";
import type { LookbackView } from "@/lib/fund/lookbackLogic";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/fundamental/useFundamentalSummaries", () => ({
  useFundamentalSummaries: vi.fn(() => ({ rows: {}, loading: false })),
}));

const render = (element: ReactElement) => renderToStaticMarkup(createElement(MantineProvider, null, element));
const entryHref = (symbol: string, stamp: string) => `/fundamental/${symbol}?entryAt=${encodeURIComponent(stamp)}#entry-valuation`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function signal(overrides: Partial<JournalSignal> = {}): JournalSignal {
  const pending = { date: null, value: null, status: "pending" as const };
  return {
    id: "amd-2h", symbol: "AMD", tf: "2h", date: "2026-09-24",
    signalTime: Date.parse("2026-09-24T15:30:00Z"), capturedAt: "2026-09-24T15:30:02Z", price: 100,
    quality: { version: "quality-v5", points: 70, available: 100, complete: true, label: "良好", dimensions: [] },
    sector: null, context: null, source: "live", outcomes: { t1: pending, t3: pending, t5: pending }, excursions: [],
    ...overrides,
  };
}

function review(signals: JournalSignal[]): Review {
  return {
    version: 1, date: "2026-09-24", previousDate: "2026-09-23", builtAt: "2026-09-25T00:00:00Z",
    market: { regime: "Neutral", summary: "", metrics: [], breadth: { today: 50, yesterday: 50, valid: 500, total: 500,
      universe: "SP500", membershipAsOf: "2026-09-24" }, strongSectors: { today: 5, yesterday: 5, total: 11 } },
    options: [], sectors: [], signals, accounts: [], warnings: [],
  };
}

function renderReview(signals: JournalSignal[]) {
  const saved = review(signals);
  return render(createElement(DailyReview, { review: saved, dates: [saved.date], journal: [], error: null }));
}

function view(): LookbackView {
  return {
    since: "2026-09-01", asOf: "2026-09-30T19:30", equity: 1, pnl: "0.0%", exposurePct: 20, curve: [], misses: [],
    rows: [{ symbol: "AMD", floatPnlPct: 0, entryPrice: 100, weightPct: 10, rps: 70, entryDate: "2026-09-24T17:30" }],
    fills: [], stats: { cagr: 0, dd: 0, mar: 0, entries: 1, rotations: 0, avgHoldings: 1, avgExposure: 10,
      tradesPerYear: 1, ytdYear: 2026, ytdPct: 0, winRatePct: null },
  };
}

function snapshot(bookView: LookbackView): FundSnapshot {
  return { epochFrom: "2026-09-01", computedAt: "2026-10-01T00:00:00Z", stale: false, fromCache: true,
    books: [{ tf: "2h", name: "2H", view: bookView }] };
}

describe("buy-point fundamental entry links", () => {
  it("deduplicates summary reads while keeping each timeframe's exact recorded signal timestamp", () => {
    const html = renderReview([signal(), signal({ id: "amd-4h", tf: "4h", signalTime: Date.parse("2026-09-24T17:30:00Z") })]);
    expect(useFundamentalSummaries).toHaveBeenCalledWith(["AMD"]);
    expect(html).toContain(entryHref("AMD", "2026-09-24T15:30:00.000Z"));
    expect(html).toContain(entryHref("AMD", "2026-09-24T17:30:00.000Z"));
    expect(html).toContain("基本面摘要单独读取最新已保存版本，可能晚于本份复盘生成时间");
    const summaryRows = [...html.matchAll(/<tr><td colspan="7">([\s\S]*?)<\/td><\/tr>/gi)].map(match => match[1]);
    expect(summaryRows).toHaveLength(2);
    for (const row of summaryRows) {
      expect(row).toContain("信号时估值");
      expect(row).not.toContain("mantine-Accordion");
    }
    expect(html).not.toContain(encodeURIComponent("2026-09-25T00:00:00.000Z"));
  });

  it("requests only the displayed top ten live signals per timeframe", () => {
    const rows = Array.from({ length: 11 }, (_, i) => signal({ id: `signal-${i}`, symbol: `A${i}`,
      quality: { ...signal().quality, points: 90 - i } }));
    rows.push(signal({ id: "replay", symbol: "REPLAY", source: "replay" }));
    rows.push(signal({ id: "other-tf", symbol: "A0", tf: "4h" }));
    const html = renderReview(rows);
    expect(useFundamentalSummaries).toHaveBeenCalledWith(Array.from({ length: 10 }, (_, i) => `A${i}`));
    expect(html).not.toContain("/fundamental/A10");
    expect(html).not.toContain("/fundamental/REPLAY");
  });

  it("never substitutes the review date or capture time for a future signal timestamp", () => {
    const html = renderReview([signal({ signalTime: Date.parse("2099-01-01T15:30:00Z") })]);
    expect(html).not.toContain("?entryAt=");
  });
});

describe("model account fundamental entry links", () => {
  it.each([false, true])("uses each holding's UTC entry timestamp, including archived readOnly=%s views", (readOnly) => {
    const bookView = view();
    bookView.rows.push({ ...bookView.rows[0], symbol: "MSFT", entryDate: "2026-09-25" });
    const fetcher = vi.fn(() => { throw new Error("Account rendering must not fetch valuations"); });
    vi.stubGlobal("fetch", fetcher);
    const html = render(createElement(FundBoard, { snapshot: snapshot(bookView), readOnly }));
    expect(html).toContain(entryHref("AMD", "2026-09-24T17:30:00.000Z"));
    expect(html).toContain("模拟入场时估值");
    expect(html).not.toContain("/fundamental/MSFT?entryAt=");
    expect(html).not.toContain(encodeURIComponent("2026-09-30T19:30:00.000Z"));
    expect(useFundamentalSummaries).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses only buy-fill timestamps and does not present sell time as entry time", () => {
    const bookView = view();
    bookView.rows = [];
    bookView.fills = [
      { date: "2026-09-24T13:30", side: "buy", symbol: "AMD", price: 100 },
      { date: "2026-09-25T17:30", side: "sell", symbol: "AMD", price: 105 },
      { date: "2026-09-24", side: "buy", symbol: "MSFT", price: 200 },
    ];
    const html = render(createElement(LiveBookCard, { tf: "2h", name: "2H", view: bookView,
      readOnly: true, fillsOpen: true, onToggleFills: vi.fn(), onOpenChart: vi.fn() }));
    expect(html).toContain(entryHref("AMD", "2026-09-24T13:30:00.000Z"));
    expect(html).not.toContain(encodeURIComponent("2026-09-25T17:30:00.000Z"));
    expect(html).not.toContain("/fundamental/MSFT?entryAt=");
    expect(html.match(/#entry-valuation/g)).toHaveLength(1);
    const sell = html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*?>卖<(?:(?!<\/tr>)[\s\S])*?<\/tr>/)?.[0];
    expect(sell).toBeDefined();
    expect(sell).not.toContain("/fundamental/");
  });
});
