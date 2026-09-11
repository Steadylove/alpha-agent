import { describe, expect, it } from "vitest";
import { formatFundRatio, fundScoreOf, tierOf } from "@/lib/scoring/fundScore";

describe("fund score", () => {
  it("按阶梯加总，并划分梯队", () => {
    const score = fundScoreOf({
      epsYoy: 0.41,
      revYoy: 0.3,
      roe: 0.2,
      dist52w: -9,
      gmTtm: 0.45,
      debtEquity: 1.2,
    });
    expect(score.total).toBe(100);
    expect(score.tier).toBe("S+");
    expect(score.complete).toBe(true);
  });

  it("中档与零档", () => {
    const score = fundScoreOf({
      epsYoy: 0.2,
      revYoy: 0.15,
      roe: 0.15,
      dist52w: -20,
      gmTtm: 0.3,
      debtEquity: 2,
    });
    expect(score.total).toBe(15 + 12 + 12 + 8 + 6 + 5);
    expect(score.tier).toBe("A+");
    expect(fundScoreOf({
      epsYoy: 0.19,
      revYoy: 0.14,
      roe: 0.14,
      dist52w: -20.1,
      gmTtm: 0.29,
      debtEquity: 2.01,
    }).total).toBe(0);
  });

  it("缺维不加分，满 5 维才给梯队", () => {
    const four = fundScoreOf({
      epsYoy: 0.5,
      revYoy: 0.4,
      roe: 0.3,
      dist52w: null,
      gmTtm: 0.5,
      debtEquity: null,
    });
    expect(four.total).toBe(75);
    expect(four.filled).toBe(4);
    expect(four.usable).toBe(false);
    expect(four.tier).toBeNull();

    const five = fundScoreOf({
      epsYoy: 0.5,
      revYoy: 0.4,
      roe: 0.3,
      dist52w: -5,
      gmTtm: 0.5,
      debtEquity: null,
    });
    expect(five.usable).toBe(true);
    expect(five.tier).toBe("S+");
  });

  it("格式化不含美元符号", () => {
    expect(formatFundRatio("epsYoy", 0.412)).toBe("+41.2%");
    expect(formatFundRatio("dist52w", -8.4)).toBe("-8.4%");
    expect(formatFundRatio("debtEquity", 1.2)).toBe("1.20");
    expect(tierOf(19)).toBe("C");
    expect(tierOf(20)).toBe("B");
    expect(tierOf(40)).toBe("A");
    expect(tierOf(70)).toBe("S");
  });
});
