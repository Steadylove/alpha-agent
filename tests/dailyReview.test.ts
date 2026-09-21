import { describe, expect, it } from "vitest";
import {
  evaluateEntry,
  journalAsOf,
  mergeEvaluation,
  cohort,
  correlation,
} from "@/lib/review/journal";
import {
  REVIEW_SECTORS,
  sectorStrength,
  marketReview,
  optionsMap,
  quoteDay,
  reviewSessions,
  type Bars,
} from "@/lib/review/market";
import { reviewAccounts } from "@/lib/review/accounts";
import { validReviewDate } from "@/lib/review/store";
import type { EntrySnapshot } from "@/lib/signals/assessment";
import type { DailyBarRow } from "@/lib/vps/loadDailyBars";
import type { GexSnapshot } from "@/lib/discord/gexCopy";
import { continuousCache } from "./liveBooksFixtures";

const row = (
  date: string,
  close: number,
  high = close,
  low = close,
): DailyBarRow => ({ date, close, high, low, open: close, volume: 100 });
// 9/7 是休市日；T+1 必须跳过周末与休市日。
const days = [
  "2026-09-04",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
  "2026-09-11",
  "2026-09-14",
];
const entry = (): EntrySnapshot => ({
  version: 1,
  id: "id",
  capturedAt: "2026-09-04T18:00:01Z",
  payload: {
    event: "buy",
    symbol: "NASDAQ:TEST",
    tf: "120",
    kind: 1,
    price: 100,
    entrySignalTime: Date.parse("2026-09-04T18:00:00Z"),
  },
  quality: {
    version: "quality-v5",
    points: 80,
    available: 100,
    complete: true,
    label: "test",
    dimensions: [{ name: "量价压力", points: 16, max: 20, reason: "当时原因" }],
  },
});
describe("事后验证不混淆交易日、股数单位和未知数据", () => {
  it("重跑断源不能抹掉已验证收益或更换原始评分", () => {
    const prices = {
      raw: days.map((d) => row(d, 100)),
      split: days.map((d) => row(d, 110)),
    };
    const old = evaluateEntry(entry(), days, prices, days[1])!;
    const next = evaluateEntry(
      { ...entry(), quality: { ...entry().quality, points: 99 } },
      days,
      null,
      days[3],
    )!;
    const result = mergeEvaluation(old, next);
    expect(result.quality.points).toBe(80);
    expect(result.outcomes.t1).toEqual(old.outcomes.t1);
    expect(result.outcomes.t3.status).toBe("missing");
    expect(result.excursions[0]).toEqual(old.excursions[0]);
  });
  it("跳过休市日，拆股还原，MFE/MAE 排除触发日已经发生的高低点", () => {
    const prices = {
      raw: days.map((d, i) => row(d, i ? 55 : 100)),
      split: days.map((d, i) => row(d, i ? 55 : 50, i ? 57 : 200, i ? 48 : 1)),
    };
    const result = evaluateEntry(entry(), days, prices, days[5])!;
    expect(result.symbol).toBe("TEST");
    expect(result.outcomes.t1.date).toBe("2026-09-08");
    expect(result.outcomes.t1.value).toBeCloseTo(10);
    expect(result.outcomes.t3.date).toBe("2026-09-10");
    expect(result.excursions.at(-1)!.mfe).toBeCloseTo(14);
    expect(result.excursions.at(-1)!.mae).toBeCloseTo(-4);
    expect(result.quality).toEqual(entry().quality);
    const historical = journalAsOf([result], days[1])[0];
    expect(historical.outcomes.t3.status).toBe("pending");
    expect(historical.outcomes.t5.value).toBeNull();
    expect(historical.excursions).toHaveLength(1);
  });
  it("股票缺失 T+1 时不顺延，缺失高低点后不声称完整 MFE", () => {
    const prices = {
      raw: [row(days[0], 100)],
      split: days.filter((_, i) => i !== 1).map((d) => row(d, 100)),
    };
    const result = evaluateEntry(entry(), days, prices, days[3])!;
    expect(result.outcomes.t1.status).toBe("missing");
    expect(result.outcomes.t3.status).toBe("ready");
    expect(result.outcomes.t5.status).toBe("pending");
    expect(result.excursions.at(-1)?.mfe).toBeNull();
    expect(cohort("test", [result])).toMatchObject({
      n: 0,
      pending: 1,
      mean: null,
      winRate: null,
    });
  });
  it("未提供原始/拆股配对行情不使用全复权 CSV 硬算；延迟信号分开留档", () => {
    const result = evaluateEntry(
      { ...entry(), capturedAt: "2026-09-08T20:00:00Z" },
      days,
      null,
      days[5],
    )!;
    expect(result.source).toBe("replay");
    expect(result.outcomes.t5.status).toBe("missing");
    expect(journalAsOf([result], days[0])).toHaveLength(0);
    expect(correlation([result], "量价压力")).toEqual({ n: 0, r: null });
  });
});

describe("市场与期权结构复盘", () => {
  it("近期日历不截断可用的历史日线，但覆盖范围内的休市日不能由错误 CSV 补入", () => {
    expect(
      reviewSessions(["2026-07-31", "2026-09-07", "2026-09-08"], {
        from: "2026-08-01",
        through: "2026-10-01",
        sessions: ["2026-09-04", "2026-09-08", "2026-09-09"],
      }),
    ).toEqual(["2026-07-31", "2026-09-04", "2026-09-08", "2026-09-09"]);
  });
  const dates = Array.from({ length: 50 }, (_, i) =>
    new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
  );
  const makeBars = (): Bars =>
    new Map(
      REVIEW_SECTORS.map((s, i) => [
        s.symbol,
        dates.map((d, j) => row(d, 100 + (i + 1) * j)),
      ]),
    );
  it("同一截面排名，缺 ETF 不改变分母，未来数据不改变历史结果", () => {
    const bars = makeBars(),
      original = sectorStrength(bars, dates, dates[45]);
    expect(original.every((s) => s.rps != null && s.d20 != null)).toBe(true);
    bars.get("SMH")!.push(row("2027-01-01", 999999));
    expect(sectorStrength(bars, dates, dates[45])).toEqual(original);
    bars.delete("SMH");
    expect(
      sectorStrength(bars, dates, dates[45]).every((s) => s.rps === null),
    ).toBe(true);
  });
  it("缺少足够市场广度时不自动判 Risk-On", () => {
    const bars = makeBars();
    for (const s of ["SPY", "QQQ", "IWM", "SPX"])
      bars.set(s, [row(dates[48], 100), row(dates[49], 101)]);
    bars.set("VIX", [row(dates[48], 20), row(dates[49], 19)]);
    const sectors = sectorStrength(bars, dates, dates[49]);
    expect(
      marketReview(bars, dates, dates[49], [], null, sectors, []).regime,
    ).toBe("Unknown");
    const members = Array.from({ length: 100 }, (_, i) => `M${i}`);
    for (const s of members)
      bars.set(s, [row(dates[48], 100), row(dates[49], 101)]);
    expect(
      marketReview(bars, dates, dates[49], members, dates[49], sectors, [])
        .regime,
    ).toBe("Risk-On");
  });
  it("Gamma 不拿过期数据当今天，DTE 不同不计算结构移动", () => {
    const current: GexSnapshot = {
      dte: "0-45d",
      items: [
        {
          symbol: "SPX",
          spot: 6000,
          as_of: "2026-09-08T16:00:00",
          net_gex: -100,
          status: "negative",
          gamma_flip: 6000,
          call_wall: 6100,
          put_wall: 5900,
        },
      ],
    };
    const prev = optionsMap(
      {
        ...current,
        items: [
          {
            ...current.items[0],
            as_of: "2026-09-04T16:00:00",
            net_gex: 100,
            gamma_flip: 6050,
          },
        ],
      },
      [],
      days[0],
      null,
    );
    expect(optionsMap(current, prev, days[1], days[0])[0].changes).toContain(
      "Net GEX 由正转负",
    );
    expect(optionsMap(current, prev, days[2], days[1])[0].today).toBeNull();
    expect(
      optionsMap({ ...current, dte: "0-7d" }, prev, days[1], days[0])[0]
        .comparable,
    ).toBe(false);
    expect(quoteDay("2026-09-09T00:15:00Z")).toBe("2026-09-08");
  });
});

describe("账本绩效以记账净值为准", () => {
  it("月度缺上月末基准时不把起始日当月初，旧日期不套最新持仓", () => {
    const cache = continuousCache();
    const result = reviewAccounts(
      cache,
      "2026-09-08",
      "2026-09-04",
      [],
      ["2026-08-31", ...days],
    );
    expect(result[0].monthly).toBeNull();
    expect(result[0].daily).toBeNull();
    expect(result[0].holdings).toBe(1);
    const old = reviewAccounts(cache, "2026-09-04", "2026-09-03");
    expect(old[0].holdings).toBeNull();
    expect(old[0].cashPct).toBeNull();
  });
  it("只归因股数未变且未交易的隔夜持仓，贡献与未归因残差合计等于日收益", () => {
    const cache = continuousCache();
    for (const b of cache.books) {
      b.view.fills = [];
      b.view.curve.unshift({
        ...b.view.curve[0],
        date: "2026-09-04",
        equity: 1.19,
      });
    }
    const old = reviewAccounts(cache, "2026-09-08", "2026-09-04").map((a) => ({
      ...a,
      equity: 1.19,
      asOf: "2026-09-04T17:30",
      positions: a.positions.map((p) => ({ ...p, mark: 110 })),
    }));
    const now = reviewAccounts(cache, "2026-09-08", "2026-09-04", old);
    expect(now[0].attribution[0].contribution).toBeCloseTo(
      ((0.001 * 10) / 1.19) * 100,
    );
    expect(now[0].attribution[0].contribution + now[0].residual!).toBeCloseTo(
      now[0].daily!,
    );
    cache.books[1].view.fills.push({
      date: "2026-09-08",
      symbol: "AAPL",
      side: "buy",
      price: 120,
    });
    expect(
      reviewAccounts(cache, "2026-09-08", "2026-09-04", old)[0].attribution,
    ).toHaveLength(0);
  });
});

it("拒绝路径穿越与不存在的日历日期", () => {
  expect(validReviewDate("../../secret")).toBe(false);
  expect(validReviewDate("2026-02-31")).toBe(false);
  expect(validReviewDate("2026-09-18")).toBe(true);
});
