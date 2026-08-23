import {
  DEFAULT_TRADE_PARAMS,
  computeRotationTrades,
  type TradeBar,
} from "@/lib/scoring/rotationTrade";
import { describe, expect, it } from "vitest";

/** 构造波幅稳定的行情，使 ATR 可预测。 */
function makeBars(closes: number[]): TradeBar[] {
  return closes.map((c, i) => ({
    date: `2020-01-${String((i % 28) + 1).padStart(2, "0")}`,
    high: c * 1.02,
    low: c * 0.98,
    close: c,
  }));
}

const noSignals = (n: number) => new Array(n).fill(false);
const allPass = (n: number) => new Array(n).fill(99);

/** 第 40 根点火（ATR 已预热），其余无信号。 */
function fireAt(n: number, index: number) {
  const sig = noSignals(n);
  sig[index] = true;
  return sig;
}

/**
 * 点火与成交相差一根：条件取自收盘价，成交只能落到次日开盘。
 * 下面的用例统一用 `SIG` 点火、`ENTRY` 断言持仓。
 */
const SIG = 40;
const ENTRY = SIG + 1;

describe("computeRotationTrades", () => {
  it("无信号时不产生任何持仓", () => {
    const bars = makeBars(new Array(100).fill(100));
    const { days, closed } = computeRotationTrades(
      "TEST",
      bars,
      noSignals(100),
      noSignals(100),
      allPass(100),
    );
    expect(closed).toHaveLength(0);
    expect(days.every((d) => d.sigType === 0)).toBe(true);
  });

  it("一买点火后次日开盘建仓，sigType 记 1", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades("TEST", bars, fireAt(n, SIG), noSignals(n), allPass(n));
    expect(days[SIG].entered).toBe(false);
    expect(days[SIG].sigType).toBe(0);
    expect(days[ENTRY].entered).toBe(true);
    expect(days[ENTRY].sigType).toBe(1);
    expect(days[ENTRY].entryPrice).toBe(100);
  });

  it("成交价取次日开盘价，不是点火根的收盘价", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    bars[ENTRY].open = 103;
    const { days } = computeRotationTrades("TEST", bars, fireAt(n, SIG), noSignals(n), allPass(n));
    expect(days[ENTRY].entryPrice).toBe(103);
  });

  it("末根点火没有次日，不成交", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days, closed } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, n - 1),
      noSignals(n),
      allPass(n),
    );
    expect(days.every((d) => d.entered === false)).toBe(true);
    expect(closed).toHaveLength(0);
  });

  it("二买点火 sigType 记 2", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades("TEST", bars, noSignals(n), fireAt(n, SIG), allPass(n));
    expect(days[ENTRY].sigType).toBe(2);
  });

  it("一买与二买同根同时触发时优先记一买", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      fireAt(n, SIG),
      allPass(n),
    );
    expect(days[ENTRY].sigType).toBe(1);
  });

  it("持仓期间再次点火不重复开仓", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const sig = noSignals(n);
    sig[SIG] = true;
    sig[45] = true;
    const { days } = computeRotationTrades("TEST", bars, sig, noSignals(n), allPass(n));
    expect(days[ENTRY].entered).toBe(true);
    expect(days[46].entered).toBe(false);
    expect(days[46].entryPrice).toBe(100);
  });

  it("RS 低于闸门时不开仓", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const lowRs = new Array(n).fill(DEFAULT_TRADE_PARAMS.minRs - 1);
    const { days, closed } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      lowRs,
    );
    expect(days.every((d) => d.sigType === 0)).toBe(true);
    expect(closed).toHaveLength(0);
  });

  it("minRs 设 0 时等同 Pine 原版，低 RS 也开仓", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      new Array(n).fill(5),
      { ...DEFAULT_TRADE_PARAMS, minRs: 0 },
    );
    expect(days[ENTRY].entered).toBe(true);
  });

  it("ATR 未预热完成前不开仓", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades("TEST", bars, fireAt(n, 3), noSignals(n), allPass(n));
    expect(days[4].entered).toBe(false);
  });

  it("初始止损为开仓价 - 4×ATR，吊灯初值更低（-5.5×ATR）", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades("TEST", bars, fireAt(n, SIG), noSignals(n), allPass(n));
    const entryDay = days[ENTRY];
    const atr = (100 - entryDay.stopLevel!) / 4;
    expect(entryDay.stopLevel).toBeCloseTo(100 - 4 * atr, 8);
    // 开仓当根吊灯已按 highWater 上抬过一次，仍应低于硬止损
    expect(entryDay.trailLevel!).toBeLessThan(entryDay.stopLevel!);
  });

  it("收盘跌破止损，次日开盘平仓并记入台账", () => {
    const n = 140;
    const closes = new Array(n).fill(100);
    for (let i = 60; i < n; i += 1) closes[i] = 50;
    const bars = makeBars(closes);
    const { closed } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].entryIndex).toBe(ENTRY);
    // 第 60 根收盘破线，成交落在 61
    expect(closed[0].exitIndex).toBe(61);
    expect(closed[0].pnlPct).toBeCloseTo(-50, 6);
    expect(closed[0].barsHeld).toBe(20);
  });

  it("出场跳空低开时按跳空价结算，亏损大于名义止损距离", () => {
    const n = 140;
    const closes = new Array(n).fill(100);
    for (let i = 60; i < n; i += 1) closes[i] = 80;
    const bars = makeBars(closes);
    bars[61].open = 70;
    const { closed } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].exitPrice).toBe(70);
    expect(closed[0].pnlPct).toBeCloseTo(-30, 6);
  });

  it("浮盈超过 10% 后止损上移到开仓价 × 1.01（保本锁）", () => {
    const n = 160;
    const closes = new Array(n).fill(100);
    for (let i = ENTRY + 1; i < n; i += 1) closes[i] = 130;
    const bars = makeBars(closes);
    const { days } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
    );
    expect(days[ENTRY + 1].breakevenLocked).toBe(true);
    expect(days[ENTRY + 1].stopLevel).toBeCloseTo(101, 6);
  });

  it("保本锁生效后，回落到开仓价附近即离场且不亏损", () => {
    const n = 200;
    const closes = new Array(n).fill(100);
    for (let i = ENTRY + 1; i < 60; i += 1) closes[i] = 130;
    for (let i = 60; i < n; i += 1) closes[i] = 100;
    const bars = makeBars(closes);
    const { closed } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].exitPrice).toBe(100);
  });

  it("吊灯止损随最高价单调上抬，不回撤", () => {
    const n = 200;
    const closes = Array.from({ length: n }, (_, i) => (i < 40 ? 100 : 100 + (i - 40) * 2));
    const bars = makeBars(closes);
    const { days } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
    );
    for (let i = 41; i < n; i += 1) {
      if (days[i].sigType === 0 || days[i - 1].sigType === 0) continue;
      expect(days[i].trailLevel!).toBeGreaterThanOrEqual(days[i - 1].trailLevel! - 1e-9);
    }
  });

  it("生效止损等于硬止损与吊灯的较大者", () => {
    const n = 200;
    const closes = Array.from({ length: n }, (_, i) => (i < 40 ? 100 : 100 + (i - 40) * 2));
    const bars = makeBars(closes);
    const { days } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
    );
    for (const day of days) {
      if (day.effectiveStop == null) continue;
      expect(day.effectiveStop).toBeCloseTo(Math.max(day.stopLevel!, day.trailLevel!), 10);
    }
  });

  it("平仓后可以再次开仓", () => {
    const n = 260;
    const closes = new Array(n).fill(100);
    for (let i = 60; i < 80; i += 1) closes[i] = 50;
    for (let i = 80; i < n; i += 1) closes[i] = 100;
    const bars = makeBars(closes);
    const sig = noSignals(n);
    sig[SIG] = true;
    sig[150] = true;
    const { closed, days } = computeRotationTrades("TEST", bars, sig, noSignals(n), allPass(n));
    expect(closed.length).toBeGreaterThanOrEqual(1);
    expect(days[151].entered).toBe(true);
  });

  it("平仓成交当根即已空仓", () => {
    const n = 140;
    const closes = new Array(n).fill(100);
    for (let i = 60; i < n; i += 1) closes[i] = 50;
    const bars = makeBars(closes);
    const { days } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
    );
    expect(days[60].exited).toBe(false);
    expect(days[61].exited).toBe(true);
    // 清仓发生在 61 的开盘，故该根本身已不算持仓
    expect(days[61].sigType).toBe(0);
    expect(days[61].entryPrice).toBeNull();
  });

  it("riskPct 在持仓期内恒定，且清仓成交那根仍然给出", () => {
    const n = 160;
    const closes = new Array(n).fill(100);
    for (let i = ENTRY + 1; i < 60; i += 1) closes[i] = 130;
    for (let i = 60; i < n; i += 1) closes[i] = 100;
    const bars = makeBars(closes);
    const { days, closed } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
    );

    expect(days[SIG].riskPct).toBeNull();
    const atEntry = days[ENTRY].riskPct!;
    expect(atEntry).toBeGreaterThan(0);

    // 保本锁会把 stopLevel 抬到开仓价之上，riskPct 不能跟着变
    expect(days[ENTRY + 1].breakevenLocked).toBe(true);
    expect(days[ENTRY + 1].riskPct).toBeCloseTo(atEntry, 10);

    // 清仓发生在 61 的开盘，那半天仍持有，组合层要靠它定权重
    expect(days[61].exited).toBe(true);
    expect(days[61].riskPct).toBeCloseTo(atEntry, 10);
    expect(days[62].riskPct).toBeNull();
    expect(closed[0].riskPct).toBeCloseTo(atEntry, 10);
  });

  it("空仓日的浮盈恒为 0", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades(
      "TEST",
      bars,
      noSignals(n),
      noSignals(n),
      allPass(n),
    );
    expect(days.every((d) => d.floatPnlPct === 0)).toBe(true);
  });

  it("空输入不抛错", () => {
    expect(computeRotationTrades("TEST", [], [], [], [])).toEqual({ days: [], closed: [] });
  });
});

describe("商业化文档独有开关（默认关闭）", () => {
  it("默认参数不启用任何商业化规则", () => {
    expect(DEFAULT_TRADE_PARAMS.useCommercialRsGate).toBe(false);
    expect(DEFAULT_TRADE_PARAMS.useEarlyBreakeven).toBe(false);
  });

  it("RS 闸门关闭时用 minRs=30，RS 50 可以开仓", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      new Array(n).fill(50),
    );
    expect(days[ENTRY].entered).toBe(true);
  });

  it("RS 闸门打开后 RS 50 被拦下，RS 70 才放行", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const gate = { ...DEFAULT_TRADE_PARAMS, useCommercialRsGate: true };

    const blocked = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      new Array(n).fill(50),
      gate,
    );
    expect(blocked.days[ENTRY].entered).toBe(false);

    const passed = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      new Array(n).fill(70),
      gate,
    );
    expect(passed.days[ENTRY].entered).toBe(true);
  });

  it("RS 跌破 40 触发一票否决清仓", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const rs = new Array(n).fill(80);
    for (let i = 60; i < n; i += 1) rs[i] = 35;

    const { closed } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      rs,
      { ...DEFAULT_TRADE_PARAMS, useCommercialRsGate: true },
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].exitIndex).toBe(61);
  });

  it("提前保本开关关闭时，浮盈 +6% 不锁保本", () => {
    const n = 120;
    const closes = new Array(n).fill(100);
    for (let i = ENTRY + 1; i < n; i += 1) closes[i] = 106;
    const { days } = computeRotationTrades(
      "TEST",
      makeBars(closes),
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
    );
    expect(days[50].breakevenLocked).toBe(false);
  });

  it("提前保本开关打开且宏观条件成立时，浮盈 +6% 即锁保本", () => {
    const n = 120;
    const closes = new Array(n).fill(100);
    for (let i = ENTRY + 1; i < n; i += 1) closes[i] = 106;
    const { days } = computeRotationTrades(
      "TEST",
      makeBars(closes),
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
      { ...DEFAULT_TRADE_PARAMS, useEarlyBreakeven: true, earlyBreakevenActive: () => true },
    );
    expect(days[50].breakevenLocked).toBe(true);
  });

  it("提前保本打开但宏观条件不成立时，仍按 +10% 触发", () => {
    const n = 120;
    const closes = new Array(n).fill(100);
    for (let i = ENTRY + 1; i < n; i += 1) closes[i] = 106;
    const { days } = computeRotationTrades(
      "TEST",
      makeBars(closes),
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
      { ...DEFAULT_TRADE_PARAMS, useEarlyBreakeven: true, earlyBreakevenActive: () => false },
    );
    expect(days[50].breakevenLocked).toBe(false);
  });
});

describe("R 倍数止盈", () => {
  /** 第 40 根开仓后单调上行，用来触发止盈。 */
  function rallyAfterEntry(n: number, entry: number, target: number) {
    const closes = new Array(n).fill(100);
    for (let i = entry + 1; i < n; i += 1) {
      closes[i] = Math.min(target, 100 + (i - entry) * 0.5);
    }
    return closes;
  }

  it("takeProfitR 为 null 时不产生止盈，行为与原版一致", () => {
    const n = 160;
    const closes = rallyAfterEntry(n, 40, 200);
    const base = computeRotationTrades(
      "TEST",
      makeBars(closes),
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
      DEFAULT_TRADE_PARAMS,
    );
    expect(base.days.every((d) => d.targetLevel === null)).toBe(true);
    expect(base.closed.every((t) => t.exitReason !== "target")).toBe(true);
  });

  it("止盈价等于开仓价加 R 倍初始风险", () => {
    const n = 160;
    const closes = rallyAfterEntry(n, 40, 200);
    const { days } = computeRotationTrades(
      "TEST",
      makeBars(closes),
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
      { ...DEFAULT_TRADE_PARAMS, takeProfitR: 2 },
    );

    const entry = days[ENTRY];
    // stopLevel 在开仓当根即为 entry - 1R，故 1R = entryPrice - stopLevel
    const oneR = entry.entryPrice! - entry.stopLevel!;
    expect(entry.targetLevel).toBeCloseTo(entry.entryPrice! + 2 * oneR, 6);
  });

  it("触及止盈后次日开盘离场并标记 exitReason", () => {
    const n = 160;
    const closes = rallyAfterEntry(n, 40, 200);
    const { closed } = computeRotationTrades(
      "TEST",
      makeBars(closes),
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
      { ...DEFAULT_TRADE_PARAMS, takeProfitR: 1 },
    );

    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe("target");
    // 1R 止盈落地的 R 倍数应在 1 附近；收盘触发会略微过冲
    expect(closed[0].pnlPct / closed[0].riskPct).toBeGreaterThanOrEqual(1);
    expect(closed[0].pnlPct / closed[0].riskPct).toBeLessThan(1.5);
  });

  it("R 越小越早离场，且落地收益随之递减", () => {
    const n = 200;
    const closes = rallyAfterEntry(n, 40, 300);
    const run = (r: number) =>
      computeRotationTrades("TEST", makeBars(closes), fireAt(n, SIG), noSignals(n), allPass(n), {
        ...DEFAULT_TRADE_PARAMS,
        takeProfitR: r,
      }).closed[0];

    const tight = run(0.5);
    const loose = run(3);
    expect(tight.barsHeld).toBeLessThan(loose.barsHeld);
    expect(tight.pnlPct).toBeLessThan(loose.pnlPct);
  });
});

describe("止损倍数可调", () => {
  it("省略 stopMult/trailMult 时与 Pine 原值 4.0 / 5.5 一致", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const omitted = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
      DEFAULT_TRADE_PARAMS,
    );
    const explicit = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, SIG),
      noSignals(n),
      allPass(n),
      { ...DEFAULT_TRADE_PARAMS, stopMult: 4.0, trailMult: 5.5 },
    );
    expect(explicit.days[ENTRY].stopLevel).toBeCloseTo(omitted.days[ENTRY].stopLevel!, 10);
    expect(explicit.days[ENTRY].trailLevel).toBeCloseTo(omitted.days[ENTRY].trailLevel!, 10);
  });

  it("收紧 stopMult 会抬高止损位并缩短持仓", () => {
    const n = 160;
    const closes = new Array(n).fill(100);
    // 开仓后缓慢下行，止损越紧越早出局
    for (let i = 41; i < n; i += 1) closes[i] = 100 - (i - 40) * 0.3;

    const run = (stopMult: number) =>
      computeRotationTrades("TEST", makeBars(closes), fireAt(n, SIG), noSignals(n), allPass(n), {
        ...DEFAULT_TRADE_PARAMS,
        stopMult,
        trailMult: 5.5,
      });

    const tight = run(1.5);
    const loose = run(4);
    expect(tight.days[ENTRY].stopLevel!).toBeGreaterThan(loose.days[ENTRY].stopLevel!);
    expect(tight.closed[0].barsHeld).toBeLessThan(loose.closed[0].barsHeld);
  });

  it("吊灯位随 trailMult 按 ATR 线性外移", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const run = (trailMult: number) =>
      computeRotationTrades("TEST", bars, fireAt(n, SIG), noSignals(n), allPass(n), {
        ...DEFAULT_TRADE_PARAMS,
        trailMult,
      }).days[ENTRY];

    const narrow = run(5.5);
    const wide = run(11);
    const entry = narrow.entryPrice!;
    // 止损位不受当根最高价影响，可反推 ATR：stopLevel = close - stopMult * atr
    const atr = (entry - narrow.stopLevel!) / DEFAULT_TRADE_PARAMS.stopMult!;

    expect(narrow.trailLevel! - wide.trailLevel!).toBeCloseTo((11 - 5.5) * atr, 6);
  });

  it("放宽 trailMult 会延后吊灯出局", () => {
    const n = 200;
    const closes = new Array(n).fill(100);
    // 先冲高进入分档收紧区，再回落触发吊灯
    for (let i = 41; i < 100; i += 1) closes[i] = 100 + (i - 40) * 1.5;
    for (let i = 100; i < n; i += 1) closes[i] = closes[99] - (i - 99) * 1.5;

    const run = (trailMult: number) =>
      computeRotationTrades("TEST", makeBars(closes), fireAt(n, SIG), noSignals(n), allPass(n), {
        ...DEFAULT_TRADE_PARAMS,
        trailMult,
      }).closed[0];

    expect(run(11).barsHeld).toBeGreaterThan(run(5.5).barsHeld);
  });
});
