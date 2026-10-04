import { describe, expect, it } from "vitest";
import { confidenceReadout, formulaReadout, scenarioScale, targetSpace } from "@/components/fundamental/readout";
import { fundamentalStateFixture } from "./fixtures/fundamental";

const valuation = () => fundamentalStateFixture().current!;

describe("fundamental scenario display geometry", () => {
  it("includes out-of-range quotes in the finite scale and preserves exact stored targets", () => {
    for (const quote of [1, 100, 10000]) {
      const value = valuation().twelveMonth, original = structuredClone(value);
      const scale = scenarioScale(value, quote)!;
      expect(scale.min).toBeLessThan(quote); expect(scale.max).toBeGreaterThan(quote);
      expect(scale.markers.map(marker => marker.value)).toEqual([value.bear.target, value.base.target, value.bull.target, quote]);
      for (const marker of scale.markers) {
        expect(marker.position).toBeCloseTo(100 * (marker.value - scale.min) / (scale.max - scale.min));
        expect(marker.position).toBeGreaterThanOrEqual(0); expect(marker.position).toBeLessThanOrEqual(100);
      }
      expect(value).toEqual(original);
    }
  });
  it("keeps coincident scenarios distinguishable in separate lanes without dividing by zero", () => {
    const value = valuation().sixMonth;
    for (const key of ["bear", "base", "bull"] as const) value[key].target = 100;
    const scale = scenarioScale(value, 100)!;
    expect(scale.markers).toHaveLength(4); expect(scale.rangeWidth).toBe(0);
    expect(scale.markers.every(marker => marker.position === 50)).toBe(true);
    expect(new Set(scale.markers.map(marker => marker.key)).size).toBe(4);
  });
  it("omits missing or invalid quotes and declines invalid scenario inputs", () => {
    const value = valuation().sixMonth;
    for (const quote of [null, 0, -10, NaN, Infinity]) expect(scenarioScale(value, quote)!.markers.map(marker => marker.key)).toEqual(["bear", "base", "bull"]);
    for (const invalid of [NaN, Infinity, 0, -1]) {
      value.bear.target = invalid;
      expect(scenarioScale(value, 100)).toBeNull();
    }
  });
  it("never substitutes target space for a probability or coerces missing price into zero", () => {
    expect(targetSpace(90, 100)).toBeCloseTo(-10);
    expect(targetSpace(120, 100)).toBeCloseTo(20);
    expect(targetSpace(100, 100)).toBe(0);
    for (const quote of [null, 0, -1, NaN, Infinity, Number.MIN_VALUE]) expect(targetSpace(100, quote)).toBeNull();
  });
});

describe("fundamental formula-only investor readout", () => {
  it("labels V1 confidence as a model preset and describes saved peer/earnings dependencies only", () => {
    const value = valuation(), result = formulaReadout(value, "unavailable");
    expect(confidenceReadout(value)).toBe("低 · V1 预设");
    expect(result.summary).toContain("3 家有效同业"); expect(result.summary).toContain("目标日期之后 12 个月");
    expect(result.dependencies.join(" ")).toContain("Non-GAAP EPS 共识");
    expect(result.aiStatus).toContain("未成功"); expect(result.uncertainties.join(" ")).toContain("尚未经过实证概率校准");
    expect(JSON.stringify(result)).not.toMatch(/买入|卖出|增长加速|盈利改善|聪明钱|低估/);
    expect(formulaReadout(value, "not-requested").aiStatus).toContain("未请求");
  });
});
