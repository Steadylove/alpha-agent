import {
  DEFAULT_STOCK_RISK_PARAMS,
  type RiskBar,
  computeStockRisk,
} from "@/lib/scoring/stockRisk";
import { describe, expect, it } from "vitest";

/** 造一段温和上行的底稿，ATR 与 RSI 都能预热。 */
function baseBars(n = 120, dailyPct = 0.2): RiskBar[] {
  const out: RiskBar[] = [];
  let close = 100;
  for (let i = 0; i < n; i += 1) {
    close *= 1 + dailyPct / 100;
    out.push({ high: close * 1.01, low: close * 0.99, close });
  }
  return out;
}

const noSignals = (n: number) => new Array(n).fill(false);

function signalAt(n: number, index: number) {
  const s = new Array(n).fill(false);
  s[index] = true;
  return s;
}

/** 关掉 RSI 闸门，专测风控本身。 */
const NO_RSI = { ...DEFAULT_STOCK_RISK_PARAMS, enableRsiFilter: false };

describe("开仓", () => {
  it("无信号时两个槽都空", () => {
    const bars = baseBars();
    const { days, closed } = computeStockRisk(bars, noSignals(120), noSignals(120));
    expect(days.at(-1)!.holding).toBe(false);
    expect(days.at(-1)!.buy1Slot.entryPrice).toBeNull();
    expect(closed).toHaveLength(0);
  });

  it("一买与二买各占一个槽，可同时持有", () => {
    const bars = baseBars();
    const { days } = computeStockRisk(bars, signalAt(120, 60), signalAt(120, 70), NO_RSI);
    const last = days.at(-1)!;
    expect(last.buy1Slot.entryPrice).toBe(bars[60].close);
    expect(last.buy2Slot.entryPrice).toBe(bars[70].close);
  });

  it("同一槽已持仓时不重复开仓", () => {
    const bars = baseBars();
    const sig = noSignals(120);
    sig[60] = true;
    sig[80] = true;
    const { days } = computeStockRisk(bars, sig, noSignals(120), NO_RSI);
    expect(days.at(-1)!.buy1Slot.entryPrice).toBe(bars[60].close);
  });

  it("初始硬止损为开仓价 − 4×ATR，移动止损为 −5.5×ATR", () => {
    const bars = baseBars();
    const { days } = computeStockRisk(bars, signalAt(120, 60), noSignals(120), NO_RSI);
    const slot = days[60].buy1Slot;
    // 从硬止损反解 ATR，再验证移动止损。注意两者锚点不同：
    // 硬止损锚在收盘价，移动止损锚在最高价（开仓当根就跑过一次持仓管理）
    const atr = (bars[60].close - slot.stopLossLevel!) / 4;
    expect(atr).toBeGreaterThan(0);
    expect(slot.trailLevel).toBeCloseTo(bars[60].high - 5.5 * atr, 8);
    expect(slot.highestHigh).toBe(bars[60].high);
    expect(slot.maxProfitPct).toBe(0);
  });

  it("ATR 未预热时不开仓", () => {
    const bars = baseBars();
    const { days } = computeStockRisk(bars, signalAt(120, 5), noSignals(120), NO_RSI);
    expect(days.at(-1)!.buy1Slot.entryPrice).toBeNull();
  });
});

describe("RSI 闸门", () => {
  it("平滑 RSI 高于 30 时放行", () => {
    const bars = baseBars();
    const { days } = computeStockRisk(bars, signalAt(120, 60), noSignals(120));
    expect(days[60].rsiOk).toBe(true);
    expect(days[60].buy1Slot.entryPrice).not.toBeNull();
  });

  it("单边下跌把平滑 RSI 压到 30 以下时拦截开仓", () => {
    const bars = baseBars(120, -0.8);
    const { days } = computeStockRisk(bars, signalAt(120, 100), noSignals(120));
    expect(days[100].smoothedRsi!).toBeLessThan(30);
    expect(days[100].rsiOk).toBe(false);
    expect(days[100].buy1Slot.entryPrice).toBeNull();
  });

  it("关闭闸门后同一根就能开仓", () => {
    const bars = baseBars(120, -0.8);
    const { days } = computeStockRisk(bars, signalAt(120, 100), noSignals(120), NO_RSI);
    expect(days[100].buy1Slot.entryPrice).not.toBeNull();
  });
});

describe("三级收紧移动止损", () => {
  /** 开仓后按 gainPct 一次性拉升，返回末日的一买槽。 */
  function afterRally(gainPct: number) {
    const bars = baseBars(80);
    const entry = bars[60].close;
    for (let i = 61; i < 80; i += 1) {
      const c = entry * (1 + gainPct / 100);
      bars[i] = { high: c * 1.001, low: c * 0.999, close: c };
    }
    const { days } = computeStockRisk(bars, signalAt(80, 60), noSignals(80), NO_RSI);
    return { slot: days.at(-1)!.buy1Slot, entry, high: bars[79].high };
  }

  it("浮盈不足 20% 时用 5.5×ATR", () => {
    const { slot, high } = afterRally(15);
    expect(slot.maxProfitPct!).toBeGreaterThanOrEqual(15);
    expect(slot.maxProfitPct!).toBeLessThan(20);
    expect(high - slot.trailLevel!).toBeGreaterThan(0);
  });

  it("浮盈越大止损跟得越紧", () => {
    const gaps = [15, 25, 50].map((g) => {
      const { slot, high } = afterRally(g);
      return (high - slot.trailLevel!) / high;
    });
    expect(gaps[1]).toBeLessThan(gaps[0]);
    expect(gaps[2]).toBeLessThan(gaps[1]);
  });

  it("移动止损只上移不下移", () => {
    const bars = baseBars(100);
    // 先冲高再回落，止损不应跟着回落
    for (let i = 61; i < 80; i += 1) {
      const c = bars[60].close * 1.5;
      bars[i] = { high: c * 1.01, low: c * 0.99, close: c };
    }
    for (let i = 80; i < 100; i += 1) {
      const c = bars[60].close * 1.05;
      bars[i] = { high: c * 1.01, low: c * 0.99, close: c };
    }
    const { days } = computeStockRisk(bars, signalAt(100, 60), noSignals(100), NO_RSI);
    const peak = days[79].buy1Slot.trailLevel;
    for (let i = 80; i < 100; i += 1) {
      const level = days[i].buy1Slot.trailLevel;
      if (level == null) break;
      expect(level).toBeGreaterThanOrEqual(peak!);
    }
  });
});

describe("保本锁", () => {
  it("浮盈达 10% 后硬止损上移到开仓价 × 1.01", () => {
    const bars = baseBars(80);
    const entry = bars[60].close;
    for (let i = 61; i < 80; i += 1) {
      const c = entry * 1.12;
      bars[i] = { high: c * 1.001, low: c * 0.999, close: c };
    }
    const { days } = computeStockRisk(bars, signalAt(80, 60), noSignals(80), NO_RSI);
    const slot = days.at(-1)!.buy1Slot;
    expect(slot.breakevenLocked).toBe(true);
    expect(slot.stopLossLevel).toBeCloseTo(entry * 1.01, 8);
  });

  it("浮盈不足 10% 时不触发", () => {
    const bars = baseBars(80);
    const { days } = computeStockRisk(bars, signalAt(80, 60), noSignals(80), NO_RSI);
    expect(days.at(-1)!.buy1Slot.breakevenLocked).toBe(false);
  });
});

describe("离场", () => {
  it("跌破移动止损后清空该槽并记录成交", () => {
    const bars = baseBars(100);
    for (let i = 61; i < 80; i += 1) {
      const c = bars[60].close * 1.5;
      bars[i] = { high: c * 1.01, low: c * 0.99, close: c };
    }
    // 一根深跌打穿所有防线
    for (let i = 80; i < 100; i += 1) {
      const c = bars[60].close * 0.5;
      bars[i] = { high: c * 1.01, low: c * 0.99, close: c };
    }
    const { days, closed } = computeStockRisk(bars, signalAt(100, 60), noSignals(100), NO_RSI);

    expect(closed).toHaveLength(1);
    expect(closed[0].slot).toBe("buy1");
    expect(closed[0].exitIndex).toBe(80);
    expect(days.at(-1)!.buy1Slot.entryPrice).toBeNull();
    expect(days.at(-1)!.holding).toBe(false);
  });

  it("离场后同一槽可再次开仓", () => {
    const bars = baseBars(140);
    for (let i = 61; i < 70; i += 1) {
      const c = bars[60].close * 0.5;
      bars[i] = { high: c * 1.01, low: c * 0.99, close: c };
    }
    const sig = noSignals(140);
    sig[60] = true;
    sig[100] = true;
    const { closed } = computeStockRisk(bars, sig, noSignals(140), NO_RSI);
    expect(closed.length).toBeGreaterThanOrEqual(1);
    expect(closed.every((t) => t.slot === "buy1")).toBe(true);
  });

  it("两个槽的离场互不影响", () => {
    const bars = baseBars(140);
    const { days } = computeStockRisk(bars, signalAt(140, 60), signalAt(140, 100), NO_RSI);
    expect(days.at(-1)!.buy1Slot.entryPrice).toBe(bars[60].close);
    expect(days.at(-1)!.buy2Slot.entryPrice).toBe(bars[100].close);
  });

  it("平仓收益按开仓价到离场价计算", () => {
    const bars = baseBars(100);
    for (let i = 61; i < 100; i += 1) {
      const c = bars[60].close * 0.5;
      bars[i] = { high: c * 1.01, low: c * 0.99, close: c };
    }
    const { closed } = computeStockRisk(bars, signalAt(100, 60), noSignals(100), NO_RSI);
    expect(closed[0].pnlPct).toBeCloseTo(-50, 6);
    expect(closed[0].barsHeld).toBe(1);
  });
});

describe("openedThisBar 与 heldBeforeThisBar", () => {
  it("开仓当根标记 openedThisBar，次根清掉", () => {
    const bars = baseBars();
    const { days } = computeStockRisk(bars, signalAt(120, 60), noSignals(120), NO_RSI);
    expect(days[60].buy1Slot.openedThisBar).toBe(true);
    expect(days[61].buy1Slot.openedThisBar).toBe(false);
    expect(days[61].buy1Slot.entryPrice).not.toBeNull();
  });

  it("开仓当根 holding 为真但 heldBeforeThisBar 为假", () => {
    const bars = baseBars();
    const { days } = computeStockRisk(bars, signalAt(120, 60), noSignals(120), NO_RSI);
    expect(days[60].holding).toBe(true);
    expect(days[60].heldBeforeThisBar).toBe(false);
    expect(days[61].heldBeforeThisBar).toBe(true);
  });

  it("另一槽早已持仓时，新开仓当根 heldBeforeThisBar 仍为真", () => {
    const bars = baseBars();
    const { days } = computeStockRisk(bars, signalAt(120, 60), signalAt(120, 90), NO_RSI);
    expect(days[90].buy2Slot.openedThisBar).toBe(true);
    expect(days[90].heldBeforeThisBar).toBe(true);
  });

  it("离场当根两者都为假", () => {
    const bars = baseBars(100);
    for (let i = 61; i < 100; i += 1) {
      const c = bars[60].close * 0.5;
      bars[i] = { high: c * 1.01, low: c * 0.99, close: c };
    }
    const { days, closed } = computeStockRisk(bars, signalAt(100, 60), noSignals(100), NO_RSI);
    const exitAt = closed[0].exitIndex;
    expect(days[exitAt].holding).toBe(false);
    expect(days[exitAt].heldBeforeThisBar).toBe(false);
  });
});

describe("边界", () => {
  it("空输入返回空结果", () => {
    expect(computeStockRisk([], [], [])).toEqual({ days: [], closed: [] });
  });

  it("信号序列长度不符时抛错", () => {
    expect(() => computeStockRisk(baseBars(10), noSignals(9), noSignals(10))).toThrow(
      /长度不一致/,
    );
  });
});
