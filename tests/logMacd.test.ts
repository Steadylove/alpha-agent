import { computeLogMacdSeries, type LogMacdBar } from "@/lib/scoring/logMacd";
import { describe, expect, it } from "vitest";

const toBars = (closes: number[]): LogMacdBar[] =>
  closes.map((c) => ({ close: c, high: c * 1.01, low: c * 0.99 }));

const ramp = (n: number, dailyPct: number, start = 100) =>
  Array.from({ length: n }, (_, i) => start * (1 + dailyPct / 100) ** i);

/** 正弦波叠加缓慢下行趋势，用于制造反复的 MACD 死叉/金叉周期。 */
const sawtooth = (n: number, period: number, amplitude: number, drift: number) =>
  Array.from(
    { length: n },
    (_, i) => 100 + amplitude * Math.sin((2 * Math.PI * i) / period) + drift * i,
  );

describe("computeLogMacdSeries", () => {
  it("输出长度与输入一致", () => {
    expect(computeLogMacdSeries(toBars(ramp(200, 0.1)))).toHaveLength(200);
  });

  it("空输入返回空数组", () => {
    expect(computeLogMacdSeries([])).toEqual([]);
  });

  it("DIF 从第 26 根（下标 25）起有值，DEA 从下标 33 起有值", () => {
    const out = computeLogMacdSeries(toBars(ramp(60, 0.5)));
    expect(out[24].dif).toBeNull();
    expect(out[25].dif).not.toBeNull();
    expect(out[32].dea).toBeNull();
    expect(out[33].dea).not.toBeNull();
  });

  it("MACD 恒等于 (DIF - DEA) × 2", () => {
    const out = computeLogMacdSeries(toBars(sawtooth(200, 40, 8, 0)));
    for (const day of out) {
      if (day.dif == null || day.dea == null) {
        expect(day.macd).toBeNull();
      } else {
        expect(day.macd).toBeCloseTo((day.dif - day.dea) * 2, 8);
      }
    }
  });

  it("单边上涨不产生任何底背离或买点", () => {
    const out = computeLogMacdSeries(toBars(ramp(400, 0.3)));
    expect(out.some((d) => d.divergenceDirect || d.divergenceIndirect)).toBe(false);
    expect(out.some((d) => d.buy1 || d.buy2)).toBe(false);
  });

  it("震荡行情能识别出死叉，且 barsSinceDeathCross 单调递增到下一次死叉", () => {
    const out = computeLogMacdSeries(toBars(sawtooth(400, 50, 10, 0)));
    const crosses = out.filter((d) => d.deathCross).length;
    expect(crosses).toBeGreaterThan(3);

    for (let i = 1; i < out.length; i += 1) {
      const prev = out[i - 1].barsSinceDeathCross;
      const cur = out[i].barsSinceDeathCross;
      if (cur == null) continue;
      if (out[i].deathCross) {
        expect(cur).toBe(0);
      } else if (prev != null) {
        expect(cur).toBe(prev + 1);
      }
    }
  });

  it("死叉当根 barsSinceDeathCross 记 0", () => {
    const out = computeLogMacdSeries(toBars(sawtooth(300, 45, 9, 0)));
    for (const day of out) {
      if (day.deathCross) expect(day.barsSinceDeathCross).toBe(0);
    }
  });

  it("买点之间至少间隔 11 根（Pine 的 barssince > 10 去抖）", () => {
    const out = computeLogMacdSeries(toBars(sawtooth(600, 35, 12, -0.05)));
    for (const key of ["buy1", "buy2"] as const) {
      const hits = out.map((d, i) => (d[key] ? i : -1)).filter((i) => i >= 0);
      for (let k = 1; k < hits.length; k += 1) {
        expect(hits[k] - hits[k - 1]).toBeGreaterThan(10);
      }
    }
  });

  it("bar 数少于最长周期（EMA90）时不抛错，且无买点", () => {
    const out = computeLogMacdSeries(toBars(ramp(50, -0.4)));
    expect(out).toHaveLength(50);
    expect(out.some((d) => d.buy1 || d.buy2)).toBe(false);
  });

  it("二买要求处于弱势区：EMA(high,24) 高于 EMA(low,90) 时不触发", () => {
    // 强势上涨中 EMA24(high) 始终在 EMA90(low) 之上
    const out = computeLogMacdSeries(toBars(ramp(500, 0.25)));
    expect(out.some((d) => d.buy2)).toBe(false);
  });

  it("全平价格不产生信号（DIF 恒为 0，无穿越）", () => {
    const out = computeLogMacdSeries(toBars(new Array(300).fill(100)));
    expect(out.some((d) => d.buy1 || d.buy2)).toBe(false);
    expect(out.some((d) => d.deathCross)).toBe(false);
  });
});
