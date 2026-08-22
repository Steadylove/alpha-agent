import {
  alphaRating,
  inShortTermDowntrend,
  mprAlphaRsSeries,
} from "@/lib/scoring/mprAlphaRs";
import { describe, expect, it } from "vitest";

/** 生成等比序列，dailyPct 为每日涨幅。 */
function ramp(n: number, dailyPct: number, start = 100): number[] {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i += 1) {
    v *= 1 + dailyPct / 100;
    out.push(v);
  }
  return out;
}

describe("f_calc_alpha_rating 七段映射", () => {
  it("各段下界返回该段的评分下界", () => {
    expect(alphaRating(195.93)).toBe(99);
    expect(alphaRating(117.11)).toBeCloseTo(90, 10);
    expect(alphaRating(99.04)).toBeCloseTo(70, 10);
    expect(alphaRating(91.66)).toBeCloseTo(50, 10);
    expect(alphaRating(80.96)).toBeCloseTo(30, 10);
    expect(alphaRating(53.64)).toBeCloseTo(10, 10);
    expect(alphaRating(24.86)).toBeCloseTo(2, 10);
  });

  it("各段上界逼近下一段的下界", () => {
    expect(alphaRating(195.92)).toBeCloseTo(98.9, 1);
    expect(alphaRating(117.1)).toBeCloseTo(89.9, 1);
    expect(alphaRating(99.03)).toBeCloseTo(69.9, 1);
  });

  it("超出上界封顶 99，低于最低段记 1", () => {
    expect(alphaRating(1000)).toBe(99);
    expect(alphaRating(24.85)).toBe(1);
    expect(alphaRating(0)).toBe(1);
    expect(alphaRating(-50)).toBe(1);
  });

  it("与基准持平（100 分）落在 70~90 段内", () => {
    const r = alphaRating(100);
    expect(r).toBeGreaterThan(70);
    expect(r).toBeLessThan(90);
  });

  it("单调不减", () => {
    let prev = -Infinity;
    for (let s = 0; s <= 220; s += 0.5) {
      const r = alphaRating(s);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
});

describe("mprAlphaRsSeries", () => {
  it("个股与基准完全相同时评分等于 alphaRating(100)", () => {
    const s = ramp(400, 0.1);
    expect(mprAlphaRsSeries(s, s).at(-1)).toBeCloseTo(alphaRating(100), 10);
  });

  it("跑赢基准时评分更高，跑输时更低", () => {
    const bench = ramp(400, 0.05);
    const strong = mprAlphaRsSeries(ramp(400, 0.25), bench).at(-1)!;
    const flat = mprAlphaRsSeries(ramp(400, 0.05), bench).at(-1)!;
    const weak = mprAlphaRsSeries(ramp(400, -0.15), bench).at(-1)!;
    expect(strong).toBeGreaterThan(flat);
    expect(flat).toBeGreaterThan(weak);
  });

  it("评分恒在 1~99 之间", () => {
    const bench = ramp(400, 0.05);
    for (const pct of [-1, -0.3, 0, 0.3, 1]) {
      for (const r of mprAlphaRsSeries(ramp(400, pct), bench)) {
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(99);
      }
    }
  });

  it("预热期历史不足时比率记 1，两边同为 1 故落在持平档", () => {
    const bench = ramp(400, 0.05);
    expect(mprAlphaRsSeries(ramp(400, 0.25), bench)[0]).toBeCloseTo(alphaRating(100), 10);
  });

  it("长度不一致时抛错", () => {
    expect(() => mprAlphaRsSeries(ramp(10, 1), ramp(9, 1))).toThrow(/长度不一致/);
  });

  it("先加权再相除，与逐项相除再加权的结果不同", () => {
    // 超额收益必须在各回看窗口上不成比例，否则两种口径会代数退化为同一个数：
    // 若 stock = k × bench 处处成立，则每一项比率都是 k 倍，先除后除结果相同。
    const bench = ramp(400, 0.05);
    // 前 250 日走弱、后 150 日转强，四个窗口的相对表现因此各不相同
    const stock = [...ramp(250, -0.1), ...ramp(150, 0.35, ramp(250, -0.1).at(-1))];
    const combined = mprAlphaRsSeries(stock, bench).at(-1)!;

    const i = stock.length - 1;
    let perTerm = 0;
    for (const { lookback, weight } of [
      { lookback: 63, weight: 0.4 },
      { lookback: 126, weight: 0.2 },
      { lookback: 189, weight: 0.2 },
      { lookback: 252, weight: 0.2 },
    ]) {
      perTerm +=
        weight * ((stock[i] / stock[i - lookback] / (bench[i] / bench[i - lookback])) * 100);
    }
    expect(combined).not.toBeCloseTo(alphaRating(perTerm), 3);
  });
});

describe("inShortTermDowntrend", () => {
  it("收盘价低于 EMA20 且 EMA20 低于 EMA50 时成立", () => {
    expect(inShortTermDowntrend(90, 95, 100)).toBe(true);
  });

  it("任一条件不满足即为假", () => {
    expect(inShortTermDowntrend(96, 95, 100)).toBe(false);
    expect(inShortTermDowntrend(90, 105, 100)).toBe(false);
  });

  it("均线预热未完成时不判空头", () => {
    expect(inShortTermDowntrend(90, null, 100)).toBe(false);
    expect(inShortTermDowntrend(90, 95, null)).toBe(false);
  });
});
