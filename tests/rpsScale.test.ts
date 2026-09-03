import { describe, expect, it } from "vitest";

import { quantileCuts, scalePercentile } from "@/lib/backtest/rpsScale";
import { percentileRank } from "@/lib/scoring/percentileRs";

describe("RPS 外生标尺", () => {
  it("切点端点对应 p1 与 p99", () => {
    const sorted = Array.from({ length: 500 }, (_, i) => i);
    const cuts = quantileCuts(sorted);
    expect(cuts).toHaveLength(99);
    expect(cuts[0]).toBeCloseTo(Math.round(0.01 * 499), 6);
    expect(cuts[49]).toBeCloseTo(Math.round(0.5 * 499), 6);
    expect(cuts[98]).toBeCloseTo(Math.round(0.99 * 499), 6);
  });

  it("两端之外夹到 [1, 99]", () => {
    const cuts = Float64Array.from(quantileCuts(Array.from({ length: 200 }, (_, i) => i)));
    expect(scalePercentile(cuts, -1e9)).toBe(1);
    expect(scalePercentile(cuts, 1e9)).toBe(99);
    expect(scalePercentile(cuts, Number.NaN)).toBe(0);
    expect(scalePercentile(new Float64Array(0), 100)).toBe(0);
  });

  it("落在切点上时百分位等于该切点的序号", () => {
    const cuts = Float64Array.from(quantileCuts(Array.from({ length: 1000 }, (_, i) => i * 3)));
    // cuts[k] 是第 k+1 个分位
    expect(scalePercentile(cuts, cuts[49])).toBeCloseTo(50, 6);
    expect(scalePercentile(cuts, cuts[24])).toBeCloseTo(25, 6);
  });

  it("与逐个比较的精确分位误差不超过 1 个分位", () => {
    // 偏态分布，比均匀分布更接近真实动量分数
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pool = Array.from({ length: 480 }, () => 100 * Math.exp(2 * rnd()));
    const cuts = Float64Array.from(quantileCuts([...pool].sort((a, b) => a - b)));

    const probes = Array.from({ length: 200 }, () => 100 * Math.exp(2 * rnd()));
    let worst = 0;
    for (const probe of probes) {
      const exact = percentileRank([...pool, probe]).at(-1)!;
      worst = Math.max(worst, Math.abs(exact - scalePercentile(cuts, probe)));
    }
    expect(worst).toBeLessThan(1);
  });
});
