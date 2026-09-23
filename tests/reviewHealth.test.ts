import { expect, it } from "vitest";
import {
  expectedReviewSession,
  gexHealth,
  reviewHealth,
} from "@/lib/review/health";
import {
  makeOptionsPublication,
  OPTION_SYMBOLS,
} from "@/lib/options/signalContext";
import {
  optionsMap,
  REVIEW_INDICES,
  REVIEW_SECTORS,
} from "@/lib/review/market";
import type { GexSnapshot } from "@/lib/options/structure";
import type { DailyReview, JournalSignal } from "@/lib/review/types";

const date = "2026-09-22",
  next = "2026-09-23";
function gex(): GexSnapshot {
  return {
    source: "cboe-delayed",
    method: "gex(S)",
    method_version: "cboe-gex-v2",
    dte: "0-45d",
    fetched_at: "2026-09-23T00:30:00+00:00",
    items: OPTION_SYMBOLS.map((symbol) => ({
      symbol,
      as_of: `${date}T16:00:00`,
      spot: 100,
      net_gex: 10,
      gamma_flip: 98,
      put_wall: 95,
      call_wall: 105,
      status: "偏正",
      contracts_used: 10,
    })),
  };
}
function healthy(): Parameters<typeof reviewHealth>[0] {
  const options = optionsMap(gex(), [], date, null);
  const review: DailyReview = {
    version: 1,
    date,
    previousDate: "2026-09-21",
    builtAt: "2026-09-23T01:00:00Z",
    warnings: [],
    options,
    signals: [],
    market: {
      regime: "Risk-On",
      summary: "",
      metrics: REVIEW_INDICES.map((symbol) => ({
        symbol,
        today: 100,
        yesterday: 99,
        change: 1,
      })),
      breadth: {
        today: 50,
        yesterday: 45,
        total: 503,
        valid: 503,
        universe: "SP500",
        membershipAsOf: date,
      },
      strongSectors: { today: 6, yesterday: 5, total: 11 },
    },
    sectors: REVIEW_SECTORS.map((s) => ({
      ...s,
      rps: 50,
      d1: 0,
      d5: 0,
      d20: 0,
      return20: 1,
      change: 1,
    })),
    accounts: (["2h", "4h"] as const).map((tf) => ({
      tf,
      asOf: `${date}T20:00:00Z`,
      equity: 1,
      daily: 1,
      monthly: null,
      holdings: 1,
      cashPct: 50,
      maxWeight: 50,
      computedAt: "2026-09-23T01:00:00Z",
      positions: [],
      traded: [],
      curve: [],
      attribution: [],
      residual: null,
      note: "",
    })),
  };
  return {
    date,
    next,
    index: {
      version: 1,
      latest: date,
      dates: [date],
      updatedAt: review.builtAt,
    },
    review,
    journal: { version: 1, asOf: date, builtAt: review.builtAt, signals: [] },
    publication: makeOptionsPublication(date, options, review.builtAt, next),
    entryIds: [],
  };
}

it("交易日检查跳过周末和休市日，拒绝过期日历", () => {
  const c = {
    from: "2026-09-01",
    through: "2026-10-01",
    sessions: ["2026-09-04", "2026-09-08", "2026-09-09"],
  };
  expect(expectedReviewSession(c, new Date("2026-09-08T00:30:00Z"))).toEqual({
    date: "2026-09-04",
    next: "2026-09-08",
  });
  expect(() =>
    expectedReviewSession(c, new Date("2026-10-05T00:30:00Z")),
  ).toThrow();
});
it("过期 Gamma 或缺标的不能通过，不把真实无 Flip 当成故障", () => {
  const snapshot = gex(),
    now = new Date("2026-09-23T01:00:00Z");
  expect(gexHealth(snapshot, date, now).errors).toEqual([]);
  snapshot.items[0].gamma_flip = null;
  expect(gexHealth(snapshot, date, now)).toMatchObject({
    errors: [],
    warnings: [expect.stringContaining("SPX")],
  });
  snapshot.items[1].as_of = "2026-09-21T16:00:00";
  expect(gexHealth(snapshot, date, now).errors).toContainEqual(
    expect.stringContaining("SPY"),
  );
  snapshot.items.pop();
  expect(gexHealth(snapshot, date, now).errors).toContainEqual(
    expect.stringContaining("IWM"),
  );
});
it("宏观延后与月收益基准缺失只警告，不无限重跑或填零", () => {
  const report = reviewHealth(healthy());
  expect(report.errors).toEqual([]);
  expect(report.warnings).toContain("2h 月收益缺少月初基准");
  expect(report.warnings).toContain("宏观观测不完整");
});
it("成功退出但复盘日期、留档上下文未更新仍然判失败", () => {
  const input = healthy();
  input.index!.latest = "2026-09-21";
  input.publication = null;
  expect(reviewHealth(input).errors).toContainEqual(
    expect.stringContaining("复盘索引"),
  );
  expect(reviewHealth(input).errors).toContainEqual(
    expect.stringContaining("上下文未发布"),
  );
});
it("原始信号漏档或已到期结果仍 pending 都会被发现，未来不报错", () => {
  const input = healthy();
  input.entryIds = ["lost"];
  input.journal!.signals = [
    {
      id: "a",
      symbol: "TEST",
      outcomes: {
        t1: { date, value: null, status: "pending" },
        t3: { date: next, value: null, status: "pending" },
        t5: { date: null, value: null, status: "pending" },
      },
    } as JournalSignal,
  ];
  expect(reviewHealth(input).errors).toEqual([
    "1 条原始买点尚未进入跟踪",
    "TEST t1 应成熟但缺少结果",
  ]);
});
