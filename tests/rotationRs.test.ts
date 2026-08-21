import { ROTATION_RS_TERMS, rotationRsRating, rotationRsSeries } from "@/lib/scoring/rotationRs";
import { describe, expect, it } from "vitest";

/** 生成每日固定涨幅的收盘序列。 */
const ramp = (n: number, dailyPct: number, start = 100) =>
  Array.from({ length: n }, (_, i) => start * (1 + dailyPct / 100) ** i);

describe("ROTATION_RS_TERMS", () => {
  it("与轮动雷达 Pine 第 115 行一致：0.20/0.40/0.20/0.20 @ 21/63/126/252", () => {
    expect(ROTATION_RS_TERMS).toEqual([
      { lookback: 21, weight: 0.2 },
      { lookback: 63, weight: 0.4 },
      { lookback: 126, weight: 0.2 },
      { lookback: 252, weight: 0.2 },
    ]);
  });

  it("权重之和为 1", () => {
    const sum = ROTATION_RS_TERMS.reduce((acc, t) => acc + t.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe("rotationRsRating", () => {
  it("横盘不动时为中位 50", () => {
    expect(rotationRsRating(new Array(300).fill(100))).toBeCloseTo(50, 10);
  });

  it("匹配 Pine 公式 50 + 48×(wp/(|wp|+28))", () => {
    const g = 0.002;
    const closes = ramp(300, g * 100);
    const wp =
      100 *
      ROTATION_RS_TERMS.reduce((acc, t) => acc + t.weight * ((1 + g) ** t.lookback - 1), 0);
    const expected = 50 + 48 * (wp / (Math.abs(wp) + 28));
    expect(rotationRsRating(closes)).toBeCloseTo(expected, 8);
  });

  it("单调上涨得高分，单调下跌得低分", () => {
    expect(rotationRsRating(ramp(300, 0.3))).toBeGreaterThan(70);
    expect(rotationRsRating(ramp(300, -0.3))).toBeLessThan(30);
  });

  it("涨幅越大评分越高（单调性）", () => {
    const scores = [0.05, 0.1, 0.2, 0.4].map((p) => rotationRsRating(ramp(300, p))!);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    }
  });

  it("上行渐近 98，[1,99] 的钳制永不生效", () => {
    const extremeUp = rotationRsRating(ramp(300, 5))!;
    expect(extremeUp).toBeGreaterThan(97);
    expect(extremeUp).toBeLessThan(98);
  });

  it("下行硬底是 12.5：跌幅最多 -100%，故加权涨幅不低于 -100", () => {
    // 50 + 48 × (-100 / 128) = 12.5，任何标的都不可能更低
    const floor = 50 + 48 * (-100 / 128);
    expect(floor).toBeCloseTo(12.5, 10);

    // 归零发生在最近 21 根内，使四个回看窗口的基准价都还在崩盘前
    const collapsed = new Array(300).fill(100);
    for (let i = 279; i < 300; i += 1) collapsed[i] = 1e-9;
    expect(rotationRsRating(collapsed)!).toBeGreaterThanOrEqual(12.5);
    expect(rotationRsRating(collapsed)!).toBeLessThan(12.6);
  });

  it("刻度不对称：RS 70 对应加权涨幅 +20%，RS 40 仅对应 -7.4%", () => {
    const wpFor = (rs: number) => {
      const k = (rs - 50) / 48;
      return (28 * k) / (1 - Math.abs(k));
    };
    expect(wpFor(70)).toBeCloseTo(20, 6);
    expect(wpFor(40)).toBeCloseTo(-7.368, 3);
  });

  it("历史不足的周期按 Pine 语义计 0，不返回 null", () => {
    // 只有 30 根：21 日有效，63/126/252 均记 0
    const closes = ramp(30, 1);
    const rating = rotationRsRating(closes);
    expect(rating).not.toBeNull();
    expect(rating!).toBeGreaterThan(50);
  });

  it("基准价为 0 时该周期计 0，不产生 Infinity", () => {
    const closes = new Array(300).fill(100);
    closes[300 - 1 - 21] = 0;
    const rating = rotationRsRating(closes);
    expect(Number.isFinite(rating!)).toBe(true);
  });

  it("空序列返回 null", () => {
    expect(rotationRsRating([])).toBeNull();
  });
});

describe("rotationRsSeries", () => {
  it("输出长度与输入一致", () => {
    expect(rotationRsSeries(ramp(300, 0.1))).toHaveLength(300);
  });

  it("末位与 rotationRsRating 一致", () => {
    const closes = ramp(300, 0.2);
    expect(rotationRsSeries(closes).at(-1)).toBeCloseTo(rotationRsRating(closes)!, 10);
  });

  it("首位存在且为有限值（Pine 对不足周期记 0，故首根也有值）", () => {
    const out = rotationRsSeries(ramp(300, 0.2));
    expect(Number.isFinite(out[0]!)).toBe(true);
    expect(out[0]).toBeCloseTo(50, 10);
  });
});
