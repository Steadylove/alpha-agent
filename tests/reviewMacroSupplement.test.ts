import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { supplementMacroReviews } from "@/lib/review/supplementMacro";
import type { TomorrowMap, WatchEvent } from "@/lib/review/tomorrow";
import {
  macroEnvironment,
  MACRO_SERIES,
  type MacroArchive,
} from "@/lib/review/macro";

const deps = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  fetch: vi.fn(),
  write: vi.fn(),
  remote: false,
}));
vi.mock("@/lib/vps/snapshot", () => ({
  readSnapshot: async (key: string) => deps.store.get(key) ?? null,
  writeSnapshot: (key: string, value: unknown) => {
    deps.write(key, value);
    deps.store.set(key, value);
  },
}));
vi.mock("@/lib/data-sources/reviewMacro", () => ({
  refreshReviewMacro: (...args: unknown[]) => deps.fetch(...args),
}));
vi.mock("@/lib/backtest/marketStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backtest/marketStore")>()),
  marketBaseUrl: () => (deps.remote ? "https://invalid.test" : null),
}));
vi.mock("@/lib/backtest/mergeBars", () => ({
  lastSettledSession: () => "2026-09-22",
}));
vi.mock("@/lib/backtest/rpsSnapshot", () => ({ readRpsSnapshot: () => null }));
vi.mock("@/lib/vps/loadDailyBars", () => ({
  loadDailyBars: async () =>
    new Map([["SPY", dates.map((date) => ({ date }))]]),
}));

const dates = [
  "2026-09-14",
  "2026-09-15",
  "2026-09-16",
  "2026-09-17",
  "2026-09-18",
  "2026-09-21",
  "2026-09-22",
];
const now = "2026-09-23T04:30:00.000Z";
function archive(end = "2026-09-22"): MacroArchive {
  return {
    version: 1,
    updatedAt: now,
    errors: [],
    series: Object.fromEntries(
      MACRO_SERIES.map((def) => [
        def.id,
        dates
          .filter((d) => d <= end)
          .map((date) => ({
            observationDate: date,
            value: def.provider === "fred" ? 4 : 100,
            availableAt: "2026-09-23T00:00:00.000Z",
            fetchedAt: now,
          })),
      ]),
    ),
  };
}
function review(date = "2026-09-22") {
  return {
    version: 1,
    date,
    previousDate: "2026-09-21",
    builtAt: "2026-09-23T01:00:00.000Z",
    market: {
      metrics: [],
      regime: "Neutral",
      engine: { version: "market-state-v2", state: "Neutral" },
      macro: macroEnvironment(archive("2026-09-21"), date, dates, now, true),
    },
    accounts: [{ tf: "2h", equity: 1.08 }],
    options: [{ symbol: "SPX", today: { spot: 7000 } }],
    sectors: [{ symbol: "XLK", rps: 100 }],
    signals: [{ id: "frozen", quality: { points: 70 } }],
    warnings: [
      "保留其他警告",
      "宏观环境关键数据不足或过期；内部市场状态仍独立计算。",
    ],
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(now));
  deps.store.clear();
  deps.write.mockClear();
  deps.fetch.mockReset();
  deps.remote = false;
  const r = review();
  deps.store.set("daily-review/index", {
    version: 1,
    latest: r.date,
    dates: [r.date],
    updatedAt: r.builtAt,
  });
  deps.store.set(`daily-review/${r.date}`, r);
  deps.store.set("daily-review/context", {
    date: r.date,
    builtAt: r.builtAt,
    ...r.market,
  });
  deps.fetch.mockResolvedValue(archive());
});
afterEach(() => vi.useRealTimers());

it("宏观补采修订观察清单，但每日信号与其他候选保持原样", async () => {
  const r = review();
  const event: WatchEvent = {
    id: "signals:new:DELL",
    domain: "signals",
    group: "portfolio",
    symbols: ["DELL"],
    source: "signals",
    title: "DELL 新触发",
    evidence: "81 分",
    focus: "观察",
    priority: 65,
  };
  const tomorrow: TomorrowMap = {
    version: "tomorrow-v1",
    date: r.date,
    targetDate: "2026-09-23",
    basis: "published",
    publishedAt: r.builtAt,
    updatedAt: r.builtAt,
    revision: 1,
    events: [event],
    candidates: [event],
    candidateCount: 1,
    notes: [],
    history: [],
    observations: [],
  };
  const followup = {
    version: "signal-followup-v1",
    date: r.date,
    observedAt: r.builtAt,
    basis: "daily",
    rows: [],
    warnings: [],
  };
  deps.store.set(`daily-review/${r.date}`, { ...r, tomorrow, followup });
  const updated = archive();
  updated.series.DGS10!.at(-1)!.value = 4.2;
  deps.fetch.mockResolvedValue(updated);
  await supplementMacroReviews();
  const after = deps.store.get(`daily-review/${r.date}`) as {
    tomorrow: TomorrowMap;
    followup: unknown;
  };
  expect(after.tomorrow.events.some((e) => e.domain === "macro")).toBe(true);
  expect(after.tomorrow.events.find((e) => e.domain === "signals")).toEqual(
    event,
  );
  expect(after.followup).toEqual(followup);
  expect(after.tomorrow.history[0].events).toEqual([event]);
  expect(after.tomorrow.publishedAt).toBe(r.builtAt);
});

it("补到观测后只更新宏观，保留首次发布、评分、账户和期权结构", async () => {
  const before = structuredClone(
    deps.store.get("daily-review/2026-09-22"),
  ) as ReturnType<typeof review>;
  const result = await supplementMacroReviews();
  expect(result.updated).toEqual(["2026-09-22"]);
  expect(result.unresolved).toEqual([]);
  const after = deps.store.get("daily-review/2026-09-22") as ReturnType<
    typeof review
  > & { publishedMarket: unknown };
  for (const key of ["signals", "accounts", "options", "sectors"] as const)
    expect(after[key]).toEqual(before[key]);
  expect(after.market.engine).toEqual(before.market.engine);
  expect(after.publishedMarket).toEqual({
    builtAt: before.builtAt,
    market: before.market,
  });
  expect(after.warnings).toEqual(["保留其他警告"]);
  expect(deps.write.mock.calls.map(([key]) => key)).toEqual([
    "daily-review/2026-09-22",
    "daily-review/context",
    "daily-review/index",
  ]);
  expect(deps.store.get("daily-review/context")).toMatchObject({
    builtAt: now,
    macro: { regime: "Neutral" },
  });
});
it("供应商没有新值时不重写复盘，即使 fetchedAt 改变", async () => {
  deps.fetch.mockResolvedValue(archive("2026-09-21"));
  const result = await supplementMacroReviews();
  expect(result.unresolved).toEqual(["2026-09-22"]);
  expect(result.updated).toEqual([]);
  expect(deps.write).not.toHaveBeenCalled();
});
it("只有最近五份已发布复盘参与补采，完整日期不重新计算", async () => {
  deps.store.set("daily-review/index", {
    version: 1,
    latest: "2026-09-22",
    dates,
    updatedAt: now,
  });
  for (const date of dates) {
    const r = review(date);
    r.market.macro.rows = [];
    deps.store.set(`daily-review/${date}`, r);
  }
  const complete = review("2026-09-21");
  // 21 日 BTC 缺周日观测，因此此测试使用更早的连续交易日作为完整样本。
  const earlier = review("2026-09-18");
  earlier.market.macro = macroEnvironment(
    archive(),
    earlier.date,
    dates,
    now,
    true,
  );
  deps.store.set(`daily-review/${earlier.date}`, earlier);
  const result = await supplementMacroReviews();
  expect(result.checked).toEqual([
    "2026-09-22",
    complete.date,
    "2026-09-17",
    "2026-09-16",
  ]);
  expect(deps.fetch).toHaveBeenCalledTimes(1);
});
it("有来源失败仍保留成功补到的字段，同时报告错误", async () => {
  const a = archive();
  a.errors = ["BTC: HTTP 503"];
  a.series.BTC = archive("2026-09-21").series.BTC;
  deps.fetch.mockResolvedValue(a);
  const result = await supplementMacroReviews();
  expect(result.updated).toEqual(["2026-09-22"]);
  expect(result.unresolved).toEqual(["2026-09-22"]);
  expect(result.errors).toEqual(["BTC: HTTP 503"]);
});
it("残缺归档不能抹掉已有观测；禁止在远程读取模式写本地", async () => {
  deps.fetch.mockResolvedValue({ ...archive(), series: {} });
  expect((await supplementMacroReviews()).errors).toHaveLength(1);
  expect(deps.write).not.toHaveBeenCalled();
  deps.remote = true;
  await expect(supplementMacroReviews()).rejects.toThrow("本地行情存储");
});
it("全部完整时不请求供应商；索引损坏时停止", async () => {
  const r = review();
  r.market.macro = macroEnvironment(archive(), r.date, dates, now, true);
  deps.store.set(`daily-review/${r.date}`, r);
  expect((await supplementMacroReviews()).checked).toEqual([]);
  expect(deps.fetch).not.toHaveBeenCalled();
  deps.store.set("daily-review/index", { version: 1, dates: ["../private"] });
  await expect(supplementMacroReviews()).rejects.toThrow("索引无效");
});
