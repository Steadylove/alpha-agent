import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { DailyReview as DailyReviewPage } from "@/components/review/DailyReview";
import { reviewAccounts } from "@/lib/review/accounts";
import type { DailyReview, ReviewAccount } from "@/lib/review/types";
import { continuousCache } from "./liveBooksFixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
const sessions = ["2026-08-31", "2026-09-01", "2026-09-04", "2026-09-08"];
function accounts() {
  const cache = continuousCache();
  cache.epochs = {
    "4h": { from: "2026-01-01", resetAt: "" },
    "2h": { from: "2026-09-01", resetAt: "2026-09-05T12:00:00Z" },
  };
  cache.books.find(book => book.tf === "2h")!.view.since = "2026-09-01";
  return cache;
}
function renderAccount(account: ReviewAccount): string {
  const review: DailyReview = { version: 1, date: "2026-09-08", previousDate: "2026-09-04", builtAt: "2026-09-09T00:00:00Z",
    market: { regime: "Neutral", summary: "", metrics: [], breadth: { today: 50, yesterday: 50, valid: 500, total: 500, universe: "SP500", membershipAsOf: "2026-09-08" }, strongSectors: { today: 5, yesterday: 5, total: 11 } },
    options: [], sectors: [], signals: [], accounts: [account], warnings: [] };
  return renderToStaticMarkup(createElement(MantineProvider, null,
    createElement(DailyReviewPage, { review, dates: [review.date], journal: [], error: null })));
}

describe("monthly return retains the same ledger baseline", () => {
  it("explains a current-month reset without using initial capital or another epoch as a monthly baseline", () => {
    const cache = accounts(), before = JSON.stringify(cache);
    const row = reviewAccounts(cache, "2026-09-08", "2026-09-04", [], sessions)[0];
    expect(row.monthly).toBeNull();
    expect(row.monthlyNote).toBe("本月重新启用记账（起点 2026-09-01），暂无完整月初基准。");
    expect(JSON.stringify(cache)).toBe(before);
  });
  it("distinguishes newly started bookkeeping, missing prior-month basis and missing review-day equity", () => {
    const cache = accounts();
    cache.epochs!["2h"].resetAt = "";
    expect(reviewAccounts(cache, "2026-09-08", "2026-09-04", [], sessions)[0].monthlyNote)
      .toBe("本月启用记账（起点 2026-09-01），暂无完整月初基准。");
    expect(reviewAccounts(cache, "2026-09-08", "2026-09-04", [], sessions)[1].monthlyNote)
      .toBe("缺少上月末同口径净值基准，暂不计算月收益。");
    expect(reviewAccounts(cache, "2026-09-04", "2026-09-03", [], sessions)[0].monthlyNote)
      .toBe("对应交易日净值缺失，暂不计算月收益。");
  });
  it("computes the next month normally once a genuine previous month-end point exists", () => {
    const cache = accounts();
    const book = cache.books.find(row => row.tf === "2h")!;
    book.view.asOf = "2026-10-01T19:30";
    book.view.curve = [
      { ...book.view.curve[0], date: "2026-09-30", equity: 1.2 },
      { ...book.view.curve[0], date: "2026-10-01", equity: 1.23 },
    ];
    const row = reviewAccounts(cache, "2026-10-01", "2026-09-30", [], ["2026-09-30", "2026-10-01"])[0];
    expect(row.monthly).toBeCloseTo(2.5);
    expect(row.monthlyNote).toBeUndefined();
  });
});

describe("account monthly baseline explanation", () => {
  it("renders the saved reset reason beside a missing monthly result", () => {
    const row = reviewAccounts(accounts(), "2026-09-08", "2026-09-04", [], sessions)[0];
    const html = renderAccount(row);
    expect(html).toContain("本月重新启用记账（起点 2026-09-01），暂无完整月初基准。");
    expect(html).not.toContain("+20.00%");
  });
  it("gives archived rows a clear fallback without inferring when they started", () => {
    const row = reviewAccounts(continuousCache(), "2026-09-08", "2026-09-04", [], sessions)[0];
    delete row.monthlyNote;
    const html = renderAccount(row);
    expect(html).toContain("缺少上月末同口径净值基准，暂不计算月收益。");
    expect(html).not.toContain("本月重新启用");
  });
  it("does not show a missing-baseline reason for an actual zero monthly result", () => {
    const row = reviewAccounts(accounts(), "2026-09-08", "2026-09-04", [], sessions)[0];
    row.monthly = 0;
    const html = renderAccount(row);
    expect(html).not.toContain("暂无完整月初基准");
    expect(html).toContain("0.00%");
  });
});
