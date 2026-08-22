import {
  actionText,
  pathTopology,
  topRiskFactors,
  transitionGrade,
} from "@/lib/scoring/mprGuidance";
import { describe, expect, it } from "vitest";

describe("pathTopology", () => {
  it("五条路径各有描述与敞口区间", () => {
    for (const pathId of [0, 1, 2, 3, 4]) {
      const t = pathTopology(pathId);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.exposureText).toMatch(/^\d+% ~ \d+% \(.+\)$/);
    }
  });

  it("敞口随路径恶化而收窄", () => {
    expect(pathTopology(0).exposureText).toContain("80% ~ 100%");
    expect(pathTopology(2).exposureText).toContain("30% ~ 50%");
    expect(pathTopology(4).exposureText).toContain("0% ~ 20%");
  });

  it("未知路径按最保守的 Path 4 处理", () => {
    expect(pathTopology(9).exposureText).toBe(pathTopology(4).exposureText);
  });
});

describe("transitionGrade", () => {
  it("路径到相变分级的映射不是恒等——Path 3 是 T1、Path 1 是 T2", () => {
    expect(transitionGrade(0).label).toContain("T0");
    expect(transitionGrade(3).label).toContain("T1");
    expect(transitionGrade(1).label).toContain("T2");
    expect(transitionGrade(2).label).toContain("T3");
    expect(transitionGrade(4).label).toContain("T4");
  });

  it("未知路径退回 T0", () => {
    expect(transitionGrade(9).label).toContain("T0");
  });
});

describe("topRiskFactors", () => {
  it("按压力降序取前两名", () => {
    const top = topRiskFactors({ f1: 10, f2: 20, f3: 90, f4: 50, f5: 30 });
    expect(top.map((t) => t.name)).toEqual(["F3 宏观避险脱节", "F4 信用利差紧缩"]);
    expect(top[0].value).toBe(90);
  });

  it("同值时保持 Pine 的初始数组顺序 F2 > F5 > F4 > F1 > F3", () => {
    const top = topRiskFactors({ f1: 50, f2: 50, f3: 50, f4: 50, f5: 50 });
    expect(top.map((t) => t.name)).toEqual(["F2 期权期限倒挂", "F5 领头羊广度背离"]);
  });

  it("恒返回两项", () => {
    expect(topRiskFactors({ f1: 0, f2: 0, f3: 0, f4: 0, f5: 0 })).toHaveLength(2);
  });
});

describe("actionText", () => {
  it("破位与扩散路径优先于个股弱势判定", () => {
    const weak = { rsRating: 5, inDowntrend: true };
    expect(actionText(4, weak)).toContain("全面破位");
    expect(actionText(2, weak)).toContain("临界扩散");
    expect(actionText(1, weak)).toContain("跨市场暗流");
  });

  it("个股弱势判定优先于微观滞涨与多头顺风", () => {
    expect(actionText(3, { rsRating: 20, inDowntrend: false })).toContain("弱势个股");
    expect(actionText(0, { rsRating: 60, inDowntrend: true })).toContain("弱势个股");
  });

  it("不传个股上下文时只走路径分支", () => {
    expect(actionText(3)).toContain("微观滞涨");
    expect(actionText(0)).toContain("多头顺风");
  });

  it("RS 恰为 30 不算弱势（Pine 用严格小于）", () => {
    expect(actionText(0, { rsRating: 30, inDowntrend: false })).toContain("多头顺风");
    expect(actionText(0, { rsRating: 29.9, inDowntrend: false })).toContain("弱势个股");
  });
});
