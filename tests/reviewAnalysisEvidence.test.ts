import { expect, it } from "vitest";
import { buildAnalysisEvidence } from "@/lib/review/analysis/evidence";
import type { AnalysisEvidence } from "@/lib/review/analysis/types";
import { marketEngine } from "@/lib/review/engine";
import { macroEnvironment } from "@/lib/review/macro";
import { optionsMap } from "@/lib/review/market";
import type { DailyReview, JournalSignal, ReviewAccount } from "@/lib/review/types";

const DATE = "2026-09-24";
const PREVIOUS = "2026-09-23";
const BUILT = "2026-09-25T01:00:00Z";
const fact = (packet: AnalysisEvidence, id: string) => packet.facts.find((f) => f.id === id)!;

function signal(over: Partial<JournalSignal> = {}): JournalSignal {
  return {
    id: "sig1", symbol: "NVDA", tf: "2h", date: DATE,
    signalTime: Date.parse(`${DATE}T18:00:00Z`), capturedAt: `${DATE}T18:00:01Z`, price: 100,
    quality: { version: "quality-v5", points: 70, available: 100, complete: true, label: "良好", dimensions: [
      { name: "强度", points: 20, max: 30, reason: "PRIVATE_ALGORITHM" },
      { name: "板块共振", points: 10, max: 15, reason: "PRIVATE_FORMULA" },
    ] },
    sector: "信息科技", context: null, source: "live",
    outcomes: {
      t1: { date: "2026-09-25", value: null, status: "pending" },
      t3: { date: "2026-09-29", value: null, status: "pending" },
      t5: { date: "2026-10-01", value: null, status: "pending" },
    }, excursions: [], ...over,
  };
}

function review(): DailyReview {
  const metrics = ["SPX", "SPY", "QQQ", "IWM", "VIX"].map((symbol) => ({ symbol, today: 100, yesterday: 99, change: 1 }));
  const gex = (date: string) => ({ source: "cboe-delayed", method: "gex(S)", method_version: "cboe-gex-v2", dte: "0-45d", fetched_at: `${date}T21:00:00Z`,
    items: ["SPX", "SPY", "QQQ", "IWM"].map((symbol) => ({ symbol, as_of: `${date}T16:00:00`, spot: 100, net_gex: -100, gamma_flip: 99, put_wall: 95, call_wall: 105, contracts_used: 100, status: "negative" })) });
  const accounts: ReviewAccount[] = (["2h", "4h"] as const).map((tf) => ({ tf, asOf: `${DATE}T20:00:00Z`, computedAt: BUILT, equity: 1.1, daily: 2, monthly: 4, holdings: 1, cashPct: 50, maxWeight: 50, positions: [], traded: [], curve: [], attribution: [{ symbol: "NVDA", contribution: 1.5 }], residual: .5, note: "" }));
  return {
    version: 1, date: DATE, previousDate: PREVIOUS, builtAt: BUILT, warnings: [],
    market: {
      regime: "Neutral", summary: "SOURCE_STORY_NOT_EVIDENCE", metrics,
      engine: marketEngine([{ date: DATE, metrics, breadth: 65, priorBreadth: 60, sectorUp: 8, sectorPrevious: 6, sector5dUp: 8, defensiveSpread: 0 }]),
      macro: macroEnvironment(null, DATE, [PREVIOUS, DATE, "2026-09-25"], BUILT),
      breadth: { today: 65, yesterday: 60, valid: 500, total: 503, universe: "标普成分股样本", membershipAsOf: DATE },
      strongSectors: { today: 8, yesterday: 6, total: 11 },
    },
    options: optionsMap(gex(DATE), optionsMap(gex(PREVIOUS), [], PREVIOUS, null), DATE, PREVIOUS),
    sectors: Array.from({ length: 14 }, (_, i) => ({ symbol: `ETF${i}`, name: `板块${i}`, group: i < 11 ? "sector" as const : "industry" as const, rps: i * 7, d1: i, d5: i - 10, d20: i - 6, return20: 10, change: i / 10 })),
    signals: [signal()], accounts,
    tomorrow: { version: "tomorrow-v1", date: DATE, targetDate: "2026-09-25", basis: "published", publishedAt: BUILT, updatedAt: BUILT, revision: 1, candidateCount: 1, events: [{ id: "market:state", domain: "market", group: "market", symbols: [], title: "观察广度", evidence: "不作为原始证据", focus: "核对参与度是否变化", source: "market", priority: 80 }], notes: [], observations: [], history: [] },
  };
}

it("七模块事实可追溯且有界，不输出核心规则、原始算法描述或输入故事", () => {
  const input = review();
  const before = JSON.stringify(input);
  const packet = buildAnalysisEvidence(input, [signal()]);
  expect(packet.states).toEqual({ market: input.market.engine!.state, legacy: "Neutral", macro: "Unknown" });
  expect(packet.coverage.map((c) => c.section)).toEqual(["market", "options", "sectors", "signals", "accounts", "journal", "tomorrow"]);
  expect(packet.facts.length).toBeLessThanOrEqual(250);
  expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(90_000);
  expect(new Set(packet.facts.map((f) => f.id)).size).toBe(packet.facts.length);
  expect(packet.facts.every((f) => /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(f.id))).toBe(true);
  expect(JSON.stringify(packet)).not.toMatch(/PRIVATE_ALGORITHM|PRIVATE_FORMULA|SOURCE_STORY_NOT_EVIDENCE|priceNoise|persistenceDays/);
  expect(fact(packet, "market.temperature").groups).toContain("market-breadth");
  expect(fact(packet, "signals.sig1.factor.1").groups).toContain("sector-rps");
  expect(fact(packet, "sectors.omitted_rows").value).toBe(14 - Number(fact(packet, "sectors.selected").value));
  expect(packet.facts.filter((f) => f.section === "tomorrow").every((f) => f.basis === "derived-only" && f.groups.includes("derived-only"))).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
});

it("旧期权值不成为当日事实，已判无效的原始字段不得绕过structure.values", () => {
  const input = review();
  input.options[0].today!.as_of = `${PREVIOUS}T16:00:00`;
  input.options[0].today!.spot = 987654;
  input.options[1].today!.call_wall = 123456;
  input.options[1].structure!.values.call_wall = null;
  input.options[1].comparison = "legacy";
  input.options[1].shifts = [{ field: "gamma_flip", from: 95, to: 99, delta: 4 }];
  const packet = buildAnalysisEvidence(input, []);
  expect(fact(packet, "options.SPX.spot")).toMatchObject({ value: null, status: "stale" });
  expect(fact(packet, "options.SPY.call_wall").value).toBeNull();
  expect(fact(packet, "options.SPY.comparable").value).toBe(false);
  expect(fact(packet, "options.SPY.shift.gamma_flip")).toBeUndefined();
  expect(JSON.stringify(packet)).not.toMatch(/987654|123456/);
});

it("期权跨日比较同时要求verified、相邻报价日和已可见采集时间", () => {
  const input = review();
  for (const row of input.options) row.shifts = [{ field: "gamma_flip", from: 95, to: 99, delta: 4 }];
  input.options[1].previous!.as_of = "2026-09-22T16:00:00";
  input.options[2].meta!.fetched_at = "2026-09-25T02:00:00Z";
  const packet = buildAnalysisEvidence(input, []);
  expect(fact(packet, "options.SPX.shift.gamma_flip").value).toBe(4);
  expect(fact(packet, "options.SPY.shift.gamma_flip")).toBeUndefined();
  expect(fact(packet, "options.QQQ.spot").value).toBeNull();
});

it("宏观缺失和Mixed/Unknown分开，未来、过期或截止后才可见值不进入当前判断", () => {
  const input = review();
  const rows = input.market.macro!.rows;
  Object.assign(rows[0], { status: "delayed", observationDate: PREVIOUS, availableAt: `${DATE}T12:00:00Z`, value: 4.2, change: 3 });
  Object.assign(rows[1], { status: "current", observationDate: "2026-09-25", availableAt: BUILT, value: 987654 });
  Object.assign(rows[2], { status: "stale", observationDate: "2026-09-20", availableAt: `${DATE}T12:00:00Z`, value: 876543 });
  Object.assign(rows[3], { status: "current", observationDate: DATE, availableAt: "2026-09-25T03:00:00Z", value: 765432 });
  const packet = buildAnalysisEvidence(input, []);
  expect(packet.states.macro).toBe("Unknown");
  expect(fact(packet, "market.macro.valid").value).toBe(1);
  expect(fact(packet, "market.macro.DGS10.value")).toMatchObject({ value: 4.2, status: "delayed", asOf: PREVIOUS });
  for (const id of ["DGS2", "DFII10", "DXY"]) expect(fact(packet, `market.macro.${id}.value`).value).toBeNull();
  expect(JSON.stringify(packet)).not.toMatch(/987654|876543|765432/);
});

it("账户必须属于本交易日，已核算贡献与未归因残差不冒充完整归因", () => {
  const input = review();
  input.accounts[1].asOf = `${PREVIOUS}T20:00:00Z`;
  input.accounts[1].daily = 987654;
  const packet = buildAnalysisEvidence(input, []);
  expect(fact(packet, "accounts.4h.daily")).toMatchObject({ value: null, status: "stale" });
  expect(fact(packet, "accounts.2h.relative_spy")).toMatchObject({ value: 1, unit: "pp" });
  expect(fact(packet, "accounts.2h.residual")).toMatchObject({ value: .5, unit: "pp" });
  expect(fact(packet, "accounts.2h.residual").note).toContain("不能自行归为现金");
  expect(fact(packet, "accounts.2h.contribution.NVDA").note).toContain("股数未变");
  expect(JSON.stringify(packet)).not.toContain("987654");
});

it("账户月度基准缺失时保留日收益但完整性标记为部分可用", () => {
  const input = review();
  input.accounts[0].monthly = null;
  const packet = buildAnalysisEvidence(input, []);
  expect(fact(packet, "accounts.2h.daily").value).toBe(2);
  expect(fact(packet, "accounts.2h.monthly")).toMatchObject({ value: null, status: "missing" });
  expect(packet.coverage.find((c) => c.section === "accounts")).toMatchObject({
    status: "partial", issues: [expect.stringContaining("本月账户收益")],
  });
});

it("多版本样本优先保留每组所有期限的成熟度与均值，MFE/MAE不挤掉末组T5", () => {
  const groups = [
    ["2h", "quality-v1"], ["2h", "quality-v4"], ["2h", "quality-v5"],
    ["4h", "quality-v4"], ["4h", "quality-v5"],
  ] as const;
  const rows = groups.map(([tf, version]) => signal({
    id: `${tf}-${version}`, tf, quality: { ...signal().quality, version },
    date: "2026-09-17", signalTime: Date.parse("2026-09-17T18:00:00Z"), capturedAt: "2026-09-17T18:00:01Z",
    outcomes: {
      t1: { date: "2026-09-18", value: 1, status: "ready" },
      t3: { date: "2026-09-22", value: 3, status: "ready" },
      t5: { date: DATE, value: 5, status: "ready" },
    }, excursions: ["2026-09-18", "2026-09-22", DATE].map((date) => ({ date, mfe: 6, mae: -2 })),
  }));
  const packet = buildAnalysisEvidence(review(), rows);
  for (const [tf, version] of groups) for (const horizon of ["t1", "t3", "t5"] as const) {
    const prefix = `journal.${tf}.live.${version}.${horizon}`;
    expect(fact(packet, `${prefix}.ready`)?.value).toBe(1);
    expect(fact(packet, `${prefix}.pending`)?.value).toBe(0);
    expect(fact(packet, `${prefix}.missing`)?.value).toBe(0);
    expect(fact(packet, `${prefix}.mean`)?.value).toBe(Number(horizon.slice(1)));
    // Ancillary risk statistics are a complete triplet or explicitly omitted as a whole.
    const diagnosticCount = ["excursion_count", "mfe", "mae"].filter((suffix) => fact(packet, `${prefix}.${suffix}`)).length;
    expect([0, 3]).toContain(diagnosticCount);
  }
  const emitted = packet.facts.filter((f) => f.section === "journal");
  // Two archive totals + five groups * (four group counts + 12 outcome facts + 9 ancillary facts).
  expect(Number(fact(packet, "journal.omitted_facts").value)).toBe(2 + 5 * 25 - (emitted.length - 1));
});

it("历史样本按周期、冻结评分版本、实时/重放分组，未来成熟结果不可泄露", () => {
  const old = signal({ id: "old", date: "2026-09-22", signalTime: Date.parse("2026-09-22T18:00:00Z"), capturedAt: "2026-09-22T18:00:01Z", outcomes: {
    t1: { date: PREVIOUS, value: 2, status: "ready" },
    t3: { date: "2026-09-25", value: 987654, status: "ready" },
    t5: { date: "2026-09-29", value: null, status: "pending" },
  }, excursions: [{ date: PREVIOUS, mfe: 3, mae: -1 }, { date: "2026-09-25", mfe: 876543, mae: -99 }] });
  const v4 = signal({ ...old, id: "v4", quality: { ...old.quality, version: "quality-v4" } });
  const replay = signal({ ...old, id: "replay", source: "replay" });
  const four = signal({ ...old, id: "four", tf: "4h" });
  const future = signal({ id: "future", capturedAt: "2026-09-25T02:00:00Z" });
  const packet = buildAnalysisEvidence(review(), [old, v4, replay, four, future]);
  expect(fact(packet, "journal.visible_count").value).toBe(4);
  expect(fact(packet, "journal.excluded_count").value).toBe(1);
  for (const group of ["2h.live.quality-v5", "2h.live.quality-v4", "2h.replay.quality-v5", "4h.live.quality-v5"]) {
    expect(fact(packet, `journal.${group}.t1.ready`).value).toBe(1);
    expect(fact(packet, `journal.${group}.t3.ready`).value).toBe(0);
    expect(fact(packet, `journal.${group}.t3.pending`).value).toBe(1);
    expect(fact(packet, `journal.${group}.t3.mean`).value).toBeNull();
  }
  expect(fact(packet, "journal.2h.live.quality-v5.t1.mean").note).toContain("不是账户成交收益");
  expect(JSON.stringify(packet)).not.toMatch(/987654|876543/);
});

it("缺项评分不折算满分，读取失败的空信号档案不被写成零信号", () => {
  const input = review();
  input.signals[0].quality = { ...input.signals[0].quality, points: 55, available: 70, complete: false };
  input.warnings = ["信号档案读取失败，相关数据保留为缺失。"];
  const packet = buildAnalysisEvidence(input, []);
  expect(fact(packet, "signals.sig1.score").value).toBeNull();
  expect(fact(packet, "signals.sig1.available").value).toBe(70);
  expect(fact(packet, "signals.2h.live.count").value).toBeNull();
  expect(packet.coverage.find((c) => c.section === "signals")!.status).toBe("unavailable");
});

it("极大输入仍限制事实和文本量，截断数量明确且没有覆盖成完整的假象", () => {
  const input = review();
  input.signals = Array.from({ length: 100 }, (_, i) => signal({ id: `sig${i}`, quality: { ...signal().quality, dimensions: Array.from({ length: 100 }, () => ({ name: "因子", points: 1, max: 10, reason: "hidden" })) } }));
  input.warnings = Array.from({ length: 100 }, () => "警告".repeat(1000));
  const many = (["2h", "4h"] as const).flatMap((tf) => (["live", "replay"] as const).flatMap((source) => (["quality-v1", "quality-v2", "quality-v3", "quality-v4", "quality-v5"] as const).map((version) => signal({ id: `${tf}-${source}-${version}`, tf, source, quality: { ...signal().quality, version } }))));
  const packet = buildAnalysisEvidence(input, many);
  expect(packet.facts.length).toBeLessThanOrEqual(490);
  expect(fact(packet, "signals.detail_omitted").value).toBe(97);
  expect(Number(fact(packet, "signals.omitted_facts").value)).toBeGreaterThan(0);
  expect(Number(fact(packet, "journal.omitted_facts").value)).toBeGreaterThan(0);
  expect(packet.coverage.find((c) => c.section === "journal")!.status).toBe("partial");
  expect(fact(packet, "market.warnings_omitted").value).toBe(95);
  expect(packet.facts.every((f) => typeof f.value !== "string" || f.value.length <= 240)).toBe(true);
  expect(new Set(packet.facts.map((f) => f.id)).size).toBe(packet.facts.length);
});
