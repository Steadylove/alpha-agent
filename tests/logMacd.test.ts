import { computeLogMacdSeries, reduceByMagnitude, type LogMacdBar } from "@/lib/scoring/logMacd";
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

/** 振幅逐步衰减的上行波：价格一路创新高而波动收窄，即顶背离的典型形态。 */
const fadingRally = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => 100 + 0.05 * i + 12 * (1 - i / n) * Math.sin((2 * Math.PI * i) / 45),
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

  it("单边上涨不产生顶背离：价格与 DIF 同步创高", () => {
    const out = computeLogMacdSeries(toBars(ramp(400, 0.3)));
    expect(out.some((d) => d.divergenceTop)).toBe(false);
  });

  it("价格创高而动能衰减时识别出顶背离，且只落在 DEA 掉头那根", () => {
    const out = computeLogMacdSeries(toBars(fadingRally(900)));
    expect(out.filter((d) => d.divergenceTop).length).toBeGreaterThan(0);

    // TP_DEA_D：DEA 的峰在前一根，即 dea[i] < dea[i-1] 且 dea[i-2] < dea[i-1]
    for (let i = 0; i < out.length; i += 1) {
      if (!out[i].divergenceTop) continue;
      expect(i).toBeGreaterThanOrEqual(2);
      const [a, b, c] = [out[i - 2].dea, out[i - 1].dea, out[i].dea];
      expect(a).not.toBeNull();
      expect(c! < b!).toBe(true);
      expect(a! < b!).toBe(true);
    }
  });

  it("从未出现顶背离时二买被否决（barsSince 为 null 取 false）", () => {
    // 单边下行里价格从不创高，TOP_D 恒假，TOP_DAYS > DC_D1 无从成立
    const out = computeLogMacdSeries(toBars(sawtooth(900, 45, 12, -0.03)));
    expect(out.some((d) => d.divergenceTop)).toBe(false);
    expect(out.some((d) => d.buy2)).toBe(false);
  });

  it("实体上沿取 max(收盘, 开盘)：抬高开盘价会改变顶背离的根数", () => {
    const closes = fadingRally(900);
    const withoutOpen = computeLogMacdSeries(toBars(closes));
    // 让每根都成为阴线，实体上沿改由开盘价决定
    const withOpen = computeLogMacdSeries(
      closes.map((c) => ({ close: c, high: c * 1.01, low: c * 0.99, open: c * 1.02 })),
    );

    // DIF/DEA 只由收盘价决定，所以差异必然来自实体上沿这一路
    expect(withOpen.map((d) => d.dif)).toEqual(withoutOpen.map((d) => d.dif));
    expect(withoutOpen.filter((d) => d.divergenceTop).length).toBeGreaterThan(0);
    expect(withOpen.filter((d) => d.divergenceTop).length).toBeGreaterThan(0);
  });
});

describe("reduceByMagnitude", () => {
  it("负数向零截断，不是向下取整", () => {
    // INTPART(-37.5) = -37，若误用 floor 会得到 -38
    expect(reduceByMagnitude([-37.5], [-50])).toEqual([-37]);
    expect(reduceByMagnitude([-1.2], [-50])).toEqual([-1]);
  });

  it("正数两种取整一致", () => {
    expect(reduceByMagnitude([37.5], [50])).toEqual([37]);
  });

  it("|参考值| 小于 1 时指数按截断算，规约位数不多降一位", () => {
    // INTPART(LOG(0.5)) - 1 = 0 - 1 = -1，除数为 10^-1
    // 若误用 floor 则为 -2，除数 10^-2，结果整体大十倍
    expect(reduceByMagnitude([0.5], [0.5])).toEqual([5]);
    expect(reduceByMagnitude([-0.5], [-0.5])).toEqual([-5]);
  });

  it("参考值为 0 或缺失时返回 null（log 无定义）", () => {
    expect(reduceByMagnitude([1, 1, null], [0, null, 50])).toEqual([null, null, null]);
  });
});
