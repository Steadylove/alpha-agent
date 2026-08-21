import {
  emaSeries,
  highestSeries,
  lowestSeries,
  percentRankSeries,
  rocSeries,
  smaSeries,
} from "@/lib/scoring/series";
import { describe, expect, it } from "vitest";

describe("series primitives", () => {
  it("smaSeries: 不足窗口为 null，其后为窗口均值", () => {
    expect(smaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("emaSeries: 第 length 根以 SMA 播种，其后按 alpha 递推", () => {
    // length=3 -> alpha=0.5，播种 SMA([1,2,3])=2
    // i=3: 0.5*4 + 0.5*2 = 3
    // i=4: 0.5*5 + 0.5*3 = 4
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("emaSeries: 数据短于窗口时全为 null", () => {
    expect(emaSeries([1, 2], 3)).toEqual([null, null]);
  });

  it("rocSeries: (v[i] - v[i-len]) / v[i-len] * 100", () => {
    const out = rocSeries([100, 110, 121], 1);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(10, 10);
    expect(out[2]).toBeCloseTo(10, 10);
  });

  it("rocSeries: 基准为 0 时返回 null，不产生 Infinity", () => {
    expect(rocSeries([0, 5], 1)[1]).toBeNull();
  });

  it("highestSeries / lowestSeries: 窗口含当前 bar", () => {
    expect(highestSeries([3, 1, 4, 1, 5], 3)).toEqual([null, null, 4, 4, 5]);
    expect(lowestSeries([3, 1, 4, 1, 5], 3)).toEqual([null, null, 1, 1, 1]);
  });

  it("percentRankSeries: 窗口不含当前 bar，统计 <= 当前值的占比", () => {
    // len=3
    // i=3 (值 30)：窗口 [50,10,20] -> <=30 的有 10,20 -> 2/3*100
    // i=4 (值 25)：窗口 [10,20,30] -> <=25 的有 10,20 -> 2/3*100
    const out = percentRankSeries([50, 10, 20, 30, 25], 3);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]).toBeCloseTo((2 / 3) * 100, 10);
    expect(out[4]).toBeCloseTo((2 / 3) * 100, 10);
  });

  it("percentRankSeries: 当前值为窗口最大时得 100", () => {
    expect(percentRankSeries([1, 2, 3, 99], 3)[3]).toBeCloseTo(100, 10);
  });

  it("percentRankSeries: 当前值严格小于窗口全部时得 0", () => {
    expect(percentRankSeries([10, 20, 30, 5], 3)[3]).toBeCloseTo(0, 10);
  });

  it("percentRankSeries: 相等的值计入分子（<= 而非 <）", () => {
    // 窗口 [5,5,5]，当前 5 -> 3/3*100 = 100
    expect(percentRankSeries([5, 5, 5, 5], 3)[3]).toBeCloseTo(100, 10);
  });
});
