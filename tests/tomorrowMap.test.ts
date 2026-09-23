import { expect, it } from "vitest";
import {
  buildTomorrowMap,
  macroWatchEvents,
  selectWatchEvents,
  supplementTomorrowMacro,
  type WatchEvent,
} from "@/lib/review/tomorrow";
import { buildFollowup, type FollowupSnapshot } from "@/lib/review/followup";
import { optionsMap } from "@/lib/review/market";
import type {
  DailyReview,
  JournalSignal,
  ReviewAccount,
} from "@/lib/review/types";
import type { RpsSnapshot } from "@/lib/backtest/rpsSnapshot";
import type { MacroRow } from "@/lib/review/macro";

const days = [
  "2026-09-18",
  "2026-09-21",
  "2026-09-22",
  "2026-09-23",
  "2026-09-24",
];
function review(date = "2026-09-22"): DailyReview {
  return {
    version: 1,
    date,
    previousDate: days[days.indexOf(date) - 1],
    builtAt: "2026-09-23T08:00:00Z",
    market: {
      regime: "Neutral",
      summary: "",
      metrics: [{ symbol: "SPY", today: 100, yesterday: 100, change: 0 }],
      breadth: {
        today: 50,
        yesterday: 50,
        total: 503,
        valid: 503,
        universe: "SP500",
        membershipAsOf: date,
      },
      strongSectors: { today: 5, yesterday: 5, total: 11 },
    },
    options: [],
    sectors: [],
    signals: [],
    accounts: [],
    warnings: [],
  };
}
function account(
  tf: "2h" | "4h",
  date: string,
  symbols: string[],
): ReviewAccount {
  return {
    tf,
    asOf: `${date}T19:30`,
    computedAt: "2026-09-23T08:00:00Z",
    equity: 1,
    daily: 0,
    monthly: 0,
    holdings: symbols.length,
    cashPct: 50,
    maxWeight: 10,
    positions: symbols.map((symbol) => ({
      symbol,
      weight: 10,
      shares: 1,
      mark: 100,
      entryDate: "2026-09-18",
    })),
    traded: [],
    curve: [],
    attribution: [],
    residual: null,
    note: "",
  };
}
function signal(
  symbol = "DELL",
  date = "2026-09-22",
  tf: "2h" | "4h" = "2h",
): JournalSignal {
  return {
    id: `${symbol}-${tf}`,
    symbol,
    tf,
    date,
    signalTime: Date.parse(`${date}T17:30:00Z`),
    capturedAt: `${date}T17:30:01Z`,
    price: 100,
    quality: {
      version: "quality-v5",
      points: 81,
      available: 100,
      complete: true,
      label: "test",
      dimensions: [],
    },
    sector: null,
    context: null,
    source: "live",
    outcomes: {
      t1: { date: null, value: null, status: "pending" },
      t3: { date: null, value: null, status: "pending" },
      t5: { date: null, value: null, status: "pending" },
    },
    excursions: [],
  };
}
function rps(value = 90, date = "2026-09-22"): RpsSnapshot {
  return {
    generatedAt: "2026-09-23T07:00:00Z",
    poolId: "SP500",
    sourceTimeframe: "1d",
    benchmark: "SP500",
    timeframes: {
      "2h": { DELL: { rps: value, asOf: date } },
      "4h": { DELL: { rps: value, asOf: date } },
    },
  };
}
function macro(change = 12, status: MacroRow["status"] = "current"): MacroRow {
  return {
    id: "DGS10",
    label: "10Y",
    source: "treasury",
    note: "",
    unit: "%",
    value: 4.5,
    change,
    changeUnit: "bp",
    observationDate: "2026-09-22",
    previousDate: "2026-09-21",
    availableAt: "2026-09-23T01:00:00Z",
    fetchedAt: "2026-09-23T07:00:00Z",
    status,
    direction: "Rising",
  };
}
const putMacro = (r: DailyReview, row: MacroRow) => {
  r.market.macro = {
    regime: "Neutral",
    effectiveDate: r.date,
    rows: [row],
    evidence: [],
    basis: "first-observed",
  };
};

it("无变化不凑数；缺失账户不生成退出，2H 与 4H 分开", () => {
  const before = review("2026-09-21"),
    now = review();
  before.accounts = [
    account("2h", before.date, ["DELL"]),
    account("4h", before.date, ["DELL"]),
  ];
  now.accounts = [
    account("2h", now.date, []),
    account("4h", now.date, ["DELL"]),
  ];
  const m = buildTomorrowMap(now, before, days[3], "published");
  expect(m.events).toHaveLength(1);
  expect(m.events[0]).toMatchObject({
    id: "accounts:2h",
    evidence: "移出 DELL",
  });
  now.accounts[0].holdings = null;
  expect(buildTomorrowMap(now, before, days[3], "published").events).toEqual(
    [],
  );
});
it("新信号只接纳完整 V5 评分；同股两个周期合并、退出后不推荐", () => {
  const r = review();
  r.signals = [
    signal(),
    signal("DELL", r.date, "4h"),
    { ...signal("LOW"), quality: { ...signal().quality, points: 60 } },
    { ...signal("MISSING"), quality: { ...signal().quality, complete: false } },
  ];
  const m = buildTomorrowMap(r, null, days[3], "published");
  expect(m.events).toHaveLength(1);
  expect(m.events[0].evidence).toContain("2H 81");
  expect(m.events[0].evidence).toContain("4H 81");
  r.followup = buildFollowup({
    review: r,
    signals: r.signals,
    rps: rps(),
    exits: r.signals.map((s) => ({
      id: s.id,
      eventTime: s.signalTime + 1000,
      capturedAt: new Date(s.signalTime + 2000).toISOString(),
    })),
    sessions: days,
    basis: "daily",
  });
  expect(buildTomorrowMap(r, null, days[3], "published").events).toHaveLength(
    0,
  );
});
it("板块排名噪声被过滤；绝对涨幅必须有同方向相对 SPY 证据", () => {
  const before = review("2026-09-21"),
    now = review();
  const sector = {
    symbol: "XLK",
    name: "科技",
    group: "sector" as const,
    rps: 50,
    d1: 0,
    d5: 0,
    d20: 0,
    return20: 1,
    change: 0,
  };
  before.sectors = [sector];
  now.sectors = [{ ...sector, rps: 80, change: 0.2 }];
  expect(
    buildTomorrowMap(now, before, days[3], "published").events,
  ).toHaveLength(0);
  now.sectors[0].change = 1;
  expect(
    buildTomorrowMap(now, before, days[3], "published").events[0].domain,
  ).toBe("sectors");
  now.sectors[0].group = "industry";
  expect(
    buildTomorrowMap(now, before, days[3], "published").events,
  ).toHaveLength(0);
});
it("期权跨版本和过期快照不入选，同版本结构切换可入选", () => {
  const r = review();
  const chain = (date: string, spot: number, version: string) => ({
    source: "cboe",
    method: "gex",
    method_version: version,
    fetched_at: "2026-09-23T01:00:00Z",
    dte: "0-45d",
    items: [
      {
        symbol: "SPX",
        status: "ok",
        as_of: `${date}T16:00:00`,
        spot,
        net_gex: 1,
        gamma_flip: 100,
        put_wall: 90,
        call_wall: 110,
        dte: "0-45d",
      },
    ],
  });
  const old = optionsMap(chain("2026-09-21", 99, "v1"), [], "2026-09-21", null);
  r.options = optionsMap(chain(r.date, 101, "v2"), old, r.date, r.previousDate);
  expect(buildTomorrowMap(r, null, days[3], "published").events).toHaveLength(
    0,
  );
  r.options = optionsMap(chain(r.date, 101, "v1"), old, r.date, r.previousDate);
  expect(buildTomorrowMap(r, null, days[3], "published").events[0].domain).toBe(
    "options",
  );
  r.options[0].today!.as_of = "2026-09-20T16:00:00";
  expect(buildTomorrowMap(r, null, days[3], "published").events).toHaveLength(
    0,
  );
});
it("利率按 bp，过期和未来可用宏观数据不触发异动", () => {
  const r = review();
  putMacro(r, macro());
  expect(macroWatchEvents(r)[0].evidence).toContain("12 bp");
  putMacro(r, macro(12, "stale"));
  expect(macroWatchEvents(r)).toHaveLength(0);
  putMacro(r, { ...macro(), availableAt: "2026-09-24T01:00:00Z" });
  expect(macroWatchEvents(r)).toHaveLength(0);
});
it("排序确定、最多五项、同类最多两项，SPX 与 SPY 去重", () => {
  const events: WatchEvent[] = Array.from({ length: 10 }, (_, i) => ({
    id: `e:${i}`,
    domain: (
      [
        "options",
        "options",
        "accounts",
        "market",
        "sectors",
        "macro",
        "signals",
      ] as const
    )[i % 7],
    group: "market",
    symbols: [i === 0 ? "SPX" : i === 1 ? "SPY" : `S${i}`],
    title: "",
    evidence: "",
    focus: "",
    source: "market",
    priority: 100 - i,
  }));
  const got = selectWatchEvents(events);
  expect(got).toHaveLength(5);
  expect(got.some((e) => e.symbols[0] === "SPY")).toBe(false);
  expect(selectWatchEvents([...events].reverse())).toEqual(got);
});
it("重跑无变化保持首次发布时间；宏观补采保留此前观察项与修订历史", () => {
  const r = review();
  r.signals = [signal()];
  const first = buildTomorrowMap(r, null, days[3], "published");
  r.builtAt = "2026-09-23T09:00:00Z";
  expect(buildTomorrowMap(r, null, days[3], "published", first)).toEqual(first);
  putMacro(r, macro());
  const next = supplementTomorrowMacro(r, first);
  expect(next.revision).toBe(2);
  expect(next.history[0].events).toEqual(first.events);
  expect(next.publishedAt).toBe(first.publishedAt);
  expect(next.events.find((e) => e.domain === "signals")).toEqual(
    first.events[0],
  );
  expect(supplementTomorrowMacro(r, next)).toEqual(next);
  r.signals = [];
  expect(buildTomorrowMap(r, null, days[3], "reconstructed", next).basis).toBe(
    "published",
  );
});
it("次日验证只使用开盘前最后一版；历史重算不冒充事前观察", () => {
  const before = review();
  putMacro(before, macro());
  before.tomorrow = buildTomorrowMap(before, null, days[3], "published");
  const now = review(days[3]);
  now.builtAt = "2026-09-24T08:00:00Z";
  putMacro(now, { ...macro(), observationDate: now.date });
  const original = before.tomorrow.events;
  before.tomorrow = {
    ...before.tomorrow,
    updatedAt: "2026-09-23T15:00:00Z",
    events: [],
    history: [{ at: "2026-09-23T08:00:00Z", reason: "late", events: original }],
  };
  expect(
    buildTomorrowMap(now, before, days[4], "published").observations,
  ).toHaveLength(1);
  before.tomorrow.basis = "reconstructed";
  expect(
    buildTomorrowMap(now, before, days[4], "published").observations,
  ).toHaveLength(0);
});
it("无卖出记录只标待复核，保留原评分并独立核对周期持仓", () => {
  const r = review(),
    s = signal("DELL", "2026-09-21");
  r.accounts = [account("2h", r.date, []), account("4h", r.date, ["DELL"])];
  const snap = buildFollowup({
    review: r,
    signals: [s],
    rps: rps(),
    exits: [],
    sessions: days,
    basis: "daily",
  });
  expect(snap.rows.find((x) => x.signalId === s.id)).toMatchObject({
    signal: "awaiting-review",
    position: "not-held",
    initialScore: 81,
  });
  expect(snap.rows.find((x) => x.tf === "4h")).toMatchObject({
    signal: "none",
    position: "held",
  });
  expect(s.quality.points).toBe(81);
});
it("RPS 历史错日不补写，走弱与回升有相邻同规则快照才确认", () => {
  const r = review(),
    s = signal("DELL", "2026-09-21");
  const build = (rp: RpsSnapshot, previous?: FollowupSnapshot) =>
    buildFollowup({
      review: r,
      signals: [s],
      rps: rp,
      previous,
      exits: [],
      sessions: days,
      basis: "daily",
    });
  const baseline = build(rps());
  baseline.date = r.previousDate!;
  const weak = build(rps(75), baseline);
  expect(weak.rows[0].strength).toBe("weakening");
  weak.date = r.previousDate!;
  expect(build(rps(82), weak).rows[0].strength).toBe("recovering");
  expect(build(rps(82, "2026-09-23"), weak).rows[0].rps).toBeNull();
  weak.date = "2026-09-18";
  expect(build(rps(75), weak).rows[0].strength).toBe("stable");
});
it("未来退出记录不关闭信号，退出身份必须匹配", () => {
  const r = review(),
    s = signal();
  const build = (id: string, eventTime: number) =>
    buildFollowup({
      review: r,
      signals: [s],
      rps: rps(),
      exits: [{ id, eventTime, capturedAt: "2026-09-23T09:00:00Z" }],
      sessions: days,
      basis: "daily",
    });
  expect(build(s.id, Date.parse("2026-09-23T14:00:00Z")).rows[0].signal).toBe(
    "new",
  );
  expect(build("other", s.signalTime + 1000).rows[0].signal).toBe("new");
});
it("暂时断源保留同日已验证观测和退出，不能跨日复制 RPS", () => {
  const r = review(),
    s = signal();
  const existing = buildFollowup({
    review: r,
    signals: [s],
    rps: rps(),
    exits: [
      {
        id: s.id,
        eventTime: s.signalTime + 1000,
        capturedAt: new Date(s.signalTime + 2000).toISOString(),
      },
    ],
    sessions: days,
    basis: "daily",
  });
  const retry = () =>
    buildFollowup({
      review: r,
      signals: [s],
      rps: null,
      exits: [],
      existing,
      sessions: days,
      basis: "daily",
      exitReadFailed: true,
    });
  expect(retry().rows[0]).toMatchObject({
    signal: "exit-recorded",
    rps: 90,
    initialScore: 81,
  });
  existing.date = r.previousDate!;
  expect(retry().rows[0]).toMatchObject({ rps: null, signal: "new" });
});
