import { percentileRank } from "@/lib/scoring/indicators";
import { describe, expect, it } from "vitest";

describe("RPS percentile rank", () => {
  it("computes O'Neil RPS as (1 - rank/N) × 100", () => {
    // 模拟 5 只：涨幅 [0.5, 0.4, 0.3, 0.2, 0.1]，第 2 名（0.4）→ rank=2 → (1-2/5)*100=60
    const universe = [0.5, 0.4, 0.3, 0.2, 0.1];
    expect(percentileRank(0.4, universe)).toBeCloseTo(60, 5);
    // 第 1 名
    expect(percentileRank(0.5, universe)).toBeCloseTo(80, 5);
    // 末名
    expect(percentileRank(0.1, universe)).toBeCloseTo(0, 5);
  });
});
