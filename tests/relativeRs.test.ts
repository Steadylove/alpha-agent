import { RELATIVE_RS_TERMS, isRsAccelerating, relativeRsSeries } from "@/lib/scoring/relativeRs";
import { describe, expect, it } from "vitest";

const ramp = (n: number, dailyPct: number, start = 100) =>
  Array.from({ length: n }, (_, i) => start * (1 + dailyPct / 100) ** i);

describe("RELATIVE_RS_TERMS", () => {
  it("与 MarketCompass Pine 第 132 行一致：0.10/0.40/0.30/0.20 @ 21/63/126/252", () => {
    expect(RELATIVE_RS_TERMS).toEqual([
      { lookback: 21, weight: 0.1 },
      { lookback: 63, weight: 0.4 },
      { lookback: 126, weight: 0.3 },
      { lookback: 252, weight: 0.2 },
    ]);
  });

  it("权重之和为 1", () => {
    expect(RELATIVE_RS_TERMS.reduce((a, t) => a + t.weight, 0)).toBeCloseTo(1, 10);
  });
});

describe("relativeRsSeries", () => {
  it("与基准同步涨跌时为中位 50（相对强度为零）", () => {
    const both = ramp(300, 0.3);
    expect(relativeRsSeries(both, both).at(-1)).toBeCloseTo(50, 8);
  });

  it("跑赢基准得高分，跑输得低分", () => {
    const bench = ramp(300, 0.1);
    expect(relativeRsSeries(ramp(300, 0.4), bench).at(-1)!).toBeGreaterThan(70);
    expect(relativeRsSeries(ramp(300, -0.2), bench).at(-1)!).toBeLessThan(30);
  });

  it("绝对下跌但跌得比基准少时仍得高分", () => {
    const stock = ramp(300, -0.1);
    const bench = ramp(300, -0.4);
    expect(relativeRsSeries(stock, bench).at(-1)!).toBeGreaterThan(50);
  });

  it("横盘的股票在熊市基准下评分高于 50", () => {
    const flat = new Array(300).fill(100);
    expect(relativeRsSeries(flat, ramp(300, -0.3)).at(-1)!).toBeGreaterThan(50);
  });

  it("超额越大评分越高（单调性）", () => {
    const bench = ramp(300, 0.1);
    const scores = [0.15, 0.2, 0.3, 0.5].map((p) => relativeRsSeries(ramp(300, p), bench).at(-1)!);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });

  it("评分恒在 1~99 之间", () => {
    const bench = ramp(300, -3);
    for (const v of relativeRsSeries(ramp(300, 3), bench)) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(99);
    }
  });

  it("历史不足的周期按 Pine 语义记比率 1.0，首根为 50", () => {
    const out = relativeRsSeries(ramp(300, 0.3), ramp(300, 0.1));
    expect(out[0]).toBeCloseTo(50, 10);
  });

  it("基准价为 0 时不产生 Infinity", () => {
    const bench = ramp(300, 0.1);
    bench[300 - 1 - 63] = 0;
    expect(Number.isFinite(relativeRsSeries(ramp(300, 0.2), bench).at(-1)!)).toBe(true);
  });

  it("长度不一致时抛错而非静默错位", () => {
    expect(() => relativeRsSeries(ramp(10, 1), ramp(9, 1))).toThrow(/长度不一致/);
  });
});

describe("isRsAccelerating", () => {
  it("近端超额强于中端时为加速", () => {
    // 前 250 根与基准同步，最后 21 根加速跑赢
    const bench = ramp(300, 0.1);
    const stock = [...bench];
    for (let i = 280; i < 300; i += 1) stock[i] = stock[i] * 1.2;
    expect(isRsAccelerating(stock, bench, 299)).toBe(true);
  });

  it("近端走弱时为衰减", () => {
    const bench = ramp(300, 0.1);
    const stock = [...bench];
    for (let i = 280; i < 300; i += 1) stock[i] = stock[i] * 0.8;
    expect(isRsAccelerating(stock, bench, 299)).toBe(false);
  });
});
