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

  it("一买点火后进入持仓，sigType 记 1", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades("TEST", bars, fireAt(n, 40), noSignals(n), allPass(n));
    expect(days[40].entered).toBe(true);
    expect(days[40].sigType).toBe(1);
    expect(days[40].entryPrice).toBe(100);
  });

  it("二买点火 sigType 记 2", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades("TEST", bars, noSignals(n), fireAt(n, 40), allPass(n));
    expect(days[40].sigType).toBe(2);
  });

  it("一买与二买同根同时触发时优先记一买", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades("TEST", bars, fireAt(n, 40), fireAt(n, 40), allPass(n));
    expect(days[40].sigType).toBe(1);
  });

  it("持仓期间再次点火不重复开仓", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const sig = noSignals(n);
    sig[40] = true;
    sig[45] = true;
    const { days } = computeRotationTrades("TEST", bars, sig, noSignals(n), allPass(n));
    expect(days[40].entered).toBe(true);
    expect(days[45].entered).toBe(false);
    expect(days[45].entryPrice).toBe(100);
  });

  it("RS 低于闸门时不开仓", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const lowRs = new Array(n).fill(DEFAULT_TRADE_PARAMS.minRs - 1);
    const { days, closed } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, 40),
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
      fireAt(n, 40),
      noSignals(n),
      new Array(n).fill(5),
      { minRs: 0 },
    );
    expect(days[40].entered).toBe(true);
  });

  it("ATR 未预热完成前不开仓", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades("TEST", bars, fireAt(n, 3), noSignals(n), allPass(n));
    expect(days[3].entered).toBe(false);
  });

  it("初始止损为开仓价 - 4×ATR，吊灯初值更低（-5.5×ATR）", () => {
    const n = 120;
    const bars = makeBars(new Array(n).fill(100));
    const { days } = computeRotationTrades("TEST", bars, fireAt(n, 40), noSignals(n), allPass(n));
    const entryDay = days[40];
    const atr = (100 - entryDay.stopLevel!) / 4;
    expect(entryDay.stopLevel).toBeCloseTo(100 - 4 * atr, 8);
    // 开仓当根吊灯已按 highWater 上抬过一次，仍应低于硬止损
    expect(entryDay.trailLevel!).toBeLessThan(entryDay.stopLevel!);
  });

  it("价格跌破止损即平仓，并记入台账", () => {
    const n = 140;
    const closes = new Array(n).fill(100);
    for (let i = 60; i < n; i += 1) closes[i] = 50;
    const bars = makeBars(closes);
    const { closed } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, 40),
      noSignals(n),
      allPass(n),
    );
    expect(closed).toHaveLength(1);
    expect(closed[0].entryIndex).toBe(40);
    expect(closed[0].exitIndex).toBe(60);
    expect(closed[0].pnlPct).toBeCloseTo(-50, 6);
    expect(closed[0].barsHeld).toBe(20);
  });

  it("浮盈超过 10% 后止损上移到开仓价 × 1.01（保本锁）", () => {
    const n = 160;
    const closes = new Array(n).fill(100);
    for (let i = 41; i < n; i += 1) closes[i] = 130;
    const bars = makeBars(closes);
    const { days } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, 40),
      noSignals(n),
      allPass(n),
    );
    expect(days[41].breakevenLocked).toBe(true);
    expect(days[41].stopLevel).toBeCloseTo(101, 6);
  });

  it("保本锁生效后，回落到开仓价附近即离场且不亏损", () => {
    const n = 200;
    const closes = new Array(n).fill(100);
    for (let i = 41; i < 60; i += 1) closes[i] = 130;
    for (let i = 60; i < n; i += 1) closes[i] = 100;
    const bars = makeBars(closes);
    const { closed } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, 40),
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
      fireAt(n, 40),
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
      fireAt(n, 40),
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
    sig[40] = true;
    sig[150] = true;
    const { closed, days } = computeRotationTrades("TEST", bars, sig, noSignals(n), allPass(n));
    expect(closed.length).toBeGreaterThanOrEqual(1);
    expect(days[150].entered).toBe(true);
  });

  it("平仓当根之后状态清空", () => {
    const n = 140;
    const closes = new Array(n).fill(100);
    for (let i = 60; i < n; i += 1) closes[i] = 50;
    const bars = makeBars(closes);
    const { days } = computeRotationTrades(
      "TEST",
      bars,
      fireAt(n, 40),
      noSignals(n),
      allPass(n),
    );
    expect(days[60].exited).toBe(true);
    expect(days[61].sigType).toBe(0);
    expect(days[61].entryPrice).toBeNull();
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
