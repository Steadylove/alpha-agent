import { describe, expect, it } from "vitest";
import { calculateReaction, eventAnchor, type ReactionInputs } from "@/lib/catalyst/reaction";
import type { CatalystEvent, CatalystUniverse, UniverseSignal } from "@/lib/catalyst/types";
import type { PanelBars } from "@/lib/backtest/panel";
import type { RpsScaleFile } from "@/lib/backtest/rpsScale";

const sessions = ["2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
const event = (patch: Partial<CatalystEvent> = {}): CatalystEvent => ({ id: "a".repeat(24), provider: "test", externalId: "1", sourceName: "fixture", sourceUrl: "https://example.com/event", title: "Test announcement", excerpt: "", type: "Corporate", importance: "medium", symbols: ["NVDA"], sectorIds: ["TECH"], scope: "stock",
  publishedAt: "2026-09-25T19:00:00Z", eventAt: null, eventDate: "2026-09-25", timePrecision: "minute", session: "regular", timing: "confirmed", status: "published", sourceUpdatedAt: null,
  firstSeenAt: "2026-09-25T19:01:00Z", lastSeenAt: "2026-10-03T10:00:00Z", revision: 1, backfilled: false, firstRelations: [], currentRelations: [], relatedSourceUrls: [], ...patch });
function panel(ticker: string, dates = sessions, close = [100, 110, 112, 108, 120, 115, 118]): PanelBars {
  return { ticker, dates: [...dates], close: Float32Array.from(close), open: null, high: Float32Array.from(close.map((value) => value + 1)), low: Float32Array.from(close.map((value) => value - 1)), volume: null };
}
const universe = (patch: Partial<CatalystUniverse> = {}): CatalystUniverse => ({ asOf: "2026-10-02", observedAt: "2026-10-03T10:00:00Z", symbols: [{ symbol: "NVDA", name: "NVDA", sectorId: "TECH", industry: "半导体", relations: [] }], sectors: [{ id: "TECH", name: "科技", etf: "XLK", leader: true }], signals: [], health: [], ...patch });
const input = (patch: Partial<ReactionInputs> = {}): ReactionInputs => ({ sessions, asOf: "2026-10-02", panels: new Map([["NVDA", panel("NVDA")]]), scale: null, universe: universe(), sessionCloses: Object.fromEntries(sessions.map((day) => [day, "16:00"])), ...patch });
const signal = (id: string, signalTime: string, capturedAt = signalTime): UniverseSignal => ({ id, symbol: "NVDA", tf: "2h", event: "buy", signalTime, capturedAt });

describe("Catalyst 精确交易日反应窗口", () => {
  it("盘前和盘中T0为当天收盘，16:00及盘后转下一真实交易日", () => {
    expect(eventAnchor(event({ publishedAt: "2026-09-25T12:00:00Z" }), sessions)).toBe("2026-09-25");
    expect(eventAnchor(event({ publishedAt: "2026-09-25T19:59:59Z" }), sessions)).toBe("2026-09-25");
    expect(eventAnchor(event({ publishedAt: "2026-09-25T20:00:00Z" }), sessions)).toBe("2026-09-28");
    expect(eventAnchor(event({ publishedAt: "2026-09-26T14:00:00Z" }), sessions)).toBe("2026-09-28");
  });

  it("官方日历跳过节假日，早收市与冬令时采用美东实际边界", () => {
    const calendar = ["2026-11-25", "2026-11-27", "2026-11-30", "2026-12-01"];
    const closes = { "2026-11-27": "13:00" };
    expect(eventAnchor(event({ publishedAt: "2026-11-26T18:00:00Z" }), calendar, closes)).toBe("2026-11-27");
    expect(eventAnchor(event({ publishedAt: "2026-11-27T17:59:00Z" }), calendar, closes)).toBe("2026-11-27");
    expect(eventAnchor(event({ publishedAt: "2026-11-27T18:00:00Z" }), calendar, closes)).toBe("2026-11-30");
    expect(eventAnchor(event({ publishedAt: "2026-11-30T20:59:00Z" }), calendar, closes)).toBe("2026-11-30");
    expect(eventAnchor(event({ publishedAt: "2026-11-30T21:00:00Z" }), calendar, closes)).toBe("2026-12-01");
  });

  it("未知分钟、计划事件、无效/不覆盖的日历不臆造锚点", () => {
    for (const patch of [{ publishedAt: null }, { timePrecision: "date" as const }, { status: "scheduled" as const }, { publishedAt: "invalid" }]) {
      expect(eventAnchor(event(patch), sessions)).toBeNull();
    }
    expect(eventAnchor(event(), [...sessions].reverse())).toBeNull();
    expect(eventAnchor(event(), ["2026-10-01", "2026-10-02"])).toBeNull();
    expect(eventAnchor(event(), sessions, { "2026-09-25": "wrong" })).toBeNull();
  });

  it("T0/T1/T3/T5从前日收盘衡量，MFE/MAE排除T0日内极值", () => {
    const values = panel("NVDA");
    values.high[1] = 1000; values.low[1] = 1;
    values.low[3] = 98;
    const result = calculateReaction(event(), "NVDA", input({ panels: new Map([["NVDA", values]]) }));
    expect(result.baseline).toEqual({ date: "2026-09-24", close: 100 });
    expect(result.price).toEqual({ t0: { date: "2026-09-25", value: 10, status: "ready" }, t1: { date: "2026-09-28", value: 12, status: "ready" }, t3: { date: "2026-09-30", value: 20, status: "ready" }, t5: { date: "2026-10-02", value: 18, status: "ready" } });
    expect(result.mfe).toEqual({ date: "2026-10-02", value: 21, status: "ready" });
    expect(result.mae.value).toBe(-2);
    expect(result.basis).toContain("all调整（含拆股和分红）");
    expect(result.basis).not.toContain("同一版拆股调整");
  });

  it("盘后事件以前一交易日收盘作基准，缺失目标日不会顺延", () => {
    const dates = sessions.filter((day) => day !== "2026-09-29");
    const values = panel("NVDA", dates, [100, 110, 112, 120, 115, 118]);
    const result = calculateReaction(event({ publishedAt: "2026-09-25T20:01:00Z" }), "NVDA", input({ panels: new Map([["NVDA", values]]) }));
    expect(result.anchorDate).toBe("2026-09-28");
    expect(result.baseline).toEqual({ date: "2026-09-25", close: 110 });
    expect(result.price.t1).toEqual({ date: "2026-09-29", value: null, status: "missing" });
    expect(result.price.t3.date).toBe("2026-10-01");
    expect(result.mfe.status).toBe("missing");
  });

  it("待成熟、缺价格与未知事件分别输出pending/missing/unavailable", () => {
    const pending = calculateReaction(event(), "NVDA", input({ asOf: "2026-09-25" }));
    expect(pending.price.t0.status).toBe("ready");
    expect(pending.price.t1.status).toBe("pending");
    expect(pending.mfe.status).toBe("pending");
    const missing = calculateReaction(event(), "NVDA", input({ panels: new Map() }));
    expect(missing.price.t0.status).toBe("missing");
    const unknown = calculateReaction(event({ timePrecision: "unknown" }), "NVDA", input());
    expect(unknown.price.t0.status).toBe("unavailable");
    expect(unknown.rps.before.status).toBe("unavailable");
    expect(unknown.mfe.status).toBe("unavailable");
    const first = calculateReaction(event(), "NVDA", input({ sessions: sessions.slice(1) }));
    expect(first.rps.before.status).toBe("missing");
    expect(first.price.t0.status).toBe("missing");
  });

  it("反应信号只取已捕获且发生在发布后至T5收盘；未知锚点不列信号", () => {
    const signals = [signal("valid", "2026-09-28T18:00:00Z"), signal("before", "2026-09-25T18:00:00Z"),
      signal("late", "2026-10-02T20:30:00Z"), signal("future-capture", "2026-09-28T18:00:00Z", "2026-10-04T00:00:00Z"),
      signal("weekend", "2026-09-26T18:00:00Z"), signal("future-signal", "2026-10-05T18:00:00Z")];
    const data = input({ universe: universe({ signals }) });
    expect(calculateReaction(event(), "NVDA", data).signalsAfter.map((row) => row.id)).toEqual(["valid"]);
    expect(calculateReaction(event({ timePrecision: "date" }), "NVDA", data).signalsAfter).toEqual([]);
    const current = input({ asOf: "2026-09-25", universe: universe({ observedAt: "2026-09-25T19:10:00Z", signals: [signal("same-day-future", "2026-09-25T19:05:00Z", "2026-09-25T19:15:00Z")] }) });
    expect(calculateReaction(event(), "NVDA", current).signalsAfter).toEqual([]);
  });
});

function longFixture() {
  const days: string[] = [];
  const cursor = new Date("2025-01-02T00:00:00Z");
  while (days.length < 261) {
    if (![0, 6].includes(cursor.getUTCDay())) days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const eventDay = days[253], observedAt = new Date(Date.parse(`${days.at(-1)}T22:00:00Z`) + 86_400_000).toISOString();
  const scale: RpsScaleFile = { generatedAt: `${days.at(-1)}T22:00:00Z`, index: "SP500", buckets: 99, dates: [...days], counts: days.map(() => 500), cuts: days.map(() => Array.from({ length: 99 }, (_, i) => 50 + i)) };
  const fixture = input({ sessions: days, asOf: days[258], panels: new Map([
    ["NVDA", panel("NVDA", days, days.map(() => 100))], ["XLK", panel("XLK", days, days.map((_, i) => 100 + i))], ["SPY", panel("SPY", days, days.map(() => 100))],
  ]), scale, universe: universe({ observedAt }) });
  return { fixture, scale, days, event: event({ publishedAt: `${eventDay}T15:00:00Z`, eventDate: eventDay }) };
}

describe("Catalyst 同口径RPS与板块反应", () => {
  it("两端使用同一个日线复合SP500标尺，板块用20交易日超额收益", () => {
    const { fixture, event: announcement, days } = longFixture();
    const result = calculateReaction(announcement, "NVDA", fixture);
    expect(result.rps.before).toEqual({ date: days[252], value: 51, status: "ready" });
    expect(result.rps.after).toEqual({ date: days[258], value: 51, status: "ready" });
    expect(result.sector.before.value).toBeCloseTo(Math.round((352 / 332 - 1) * 10000) / 100);
    expect(result.sector.after.value).toBeCloseTo(Math.round((358 / 338 - 1) * 10000) / 100);
  });

  it.each(["small", "nan-count", "unsorted", "wrong-index", "short-cuts", "bad-base", "future-scale"])("拒绝不可靠标尺或价格：%s", (failure) => {
    const { fixture, scale, event: announcement } = longFixture();
    if (failure === "small") scale.counts[252] = 449;
    if (failure === "nan-count") scale.counts[252] = NaN;
    if (failure === "unsorted") scale.cuts[252][20] = -10;
    if (failure === "wrong-index") scale.index = "OTHER";
    if (failure === "short-cuts") scale.cuts[252].pop();
    if (failure === "bad-base") fixture.panels.get("NVDA")!.close[0] = -1;
    if (failure === "future-scale") scale.generatedAt = "2030-01-01T00:00:00Z";
    expect(calculateReaction(announcement, "NVDA", fixture).rps.before.status).toBe("missing");
  });

  it("450个有效样本允许，同值分位切点允许；缺失20日前ETF报价不替代", () => {
    const { fixture, scale, event: announcement } = longFixture();
    scale.counts[252] = 450;
    scale.cuts[252].fill(100);
    fixture.panels.get("XLK")!.close[232] = NaN;
    const result = calculateReaction(announcement, "NVDA", fixture);
    expect(result.rps.before.status).toBe("ready");
    expect(result.sector.before.status).toBe("missing");
  });
});
