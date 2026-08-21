import {
  atrSeries,
  barsSinceSeries,
  crossSeries,
  emaSeries,
  obvSeries,
  rmaSeries,
  rsiSeries,
  stdevSeries,
  trueRangeSeries,
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

describe("stdevSeries", () => {
  it("用总体标准差（除以 n），不是样本标准差", () => {
    // [2,4,4,4] 均值 3.5，总体方差 = (2.25+0.25+0.25+0.25)/4 = 0.75
    expect(stdevSeries([2, 4, 4, 4], 4)[3]).toBeCloseTo(Math.sqrt(0.75), 10);
  });

  it("恒定序列标准差为 0", () => {
    expect(stdevSeries([5, 5, 5, 5], 3)[3]).toBeCloseTo(0, 10);
  });

  it("窗口不足处为 null", () => {
    expect(stdevSeries([1, 2, 3], 3).slice(0, 2)).toEqual([null, null]);
  });
});

describe("obvSeries", () => {
  it("收涨累加、收跌累减、平盘不动", () => {
    const closes = [10, 11, 10, 10, 12];
    const volumes = [100, 200, 300, 400, 500];
    expect(obvSeries(closes, volumes)).toEqual([0, 200, -100, -100, 400]);
  });

  it("首根恒为 0", () => {
    expect(obvSeries([10], [999])[0]).toBe(0);
  });

  it("单边上涨时等于成交量累计", () => {
    const out = obvSeries([1, 2, 3, 4], [10, 20, 30, 40]);
    expect(out.at(-1)).toBe(90);
  });
});

describe("rsiSeries", () => {
  it("只涨不跌时为 100", () => {
    const out = rsiSeries([1, 2, 3, 4, 5, 6, 7, 8], 3);
    expect(out.at(-1)).toBe(100);
  });

  it("只跌不涨时为 0", () => {
    const out = rsiSeries([8, 7, 6, 5, 4, 3, 2, 1], 3);
    expect(out.at(-1)).toBe(0);
  });

  it("涨跌等幅交替时在 50 附近上下摆动", () => {
    // Wilder 平滑给近端更高权重，所以涨日略高于 50、跌日略低，不会精确收敛
    const values = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const out = rsiSeries(values, 14);
    const onUpDay = out[199]!;
    const onDownDay = out[198]!;
    expect(onUpDay).toBeGreaterThan(50);
    expect(onDownDay).toBeLessThan(50);
    expect((onUpDay + onDownDay) / 2).toBeCloseTo(50, 1);
  });

  it("预热期为 null，第 length+1 根起有值", () => {
    const out = rsiSeries([1, 2, 3, 4, 5, 6], 3);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]).not.toBeNull();
  });

  it("恒定序列涨跌均为 0，按 ta.rsi 语义取 100", () => {
    expect(rsiSeries(new Array(50).fill(100), 14).at(-1)).toBe(100);
  });

  it("输出恒在 0~100 之间", () => {
    const values = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.05);
    for (const v of rsiSeries(values, 14)) {
      if (v == null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe("rmaSeries", () => {
  it("首个值为 SMA 播种，其后按 alpha = 1/length 递推", () => {
    const out = rmaSeries([1, 2, 3, 10], 3);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBeCloseTo(2, 10);
    // 2 + (10 - 2) / 3
    expect(out[3]).toBeCloseTo(2 + 8 / 3, 10);
  });

  it("恒定序列的 RMA 恒等于该常数", () => {
    for (const v of rmaSeries(new Array(20).fill(7), 5).slice(4)) {
      expect(v).toBeCloseTo(7, 10);
    }
  });

  it("比同长度 EMA 更平滑（alpha 更小）", () => {
    const spike = [...new Array(10).fill(1), 100];
    const rma = rmaSeries(spike, 5).at(-1)!;
    const ema = emaSeries(spike, 5).at(-1)!;
    expect(rma).toBeLessThan(ema);
  });

  it("长度不足时全为 null", () => {
    expect(rmaSeries([1, 2], 5)).toEqual([null, null]);
  });
});

describe("trueRangeSeries / atrSeries", () => {
  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 12, low: 9, close: 11 },
    { high: 11, low: 7, close: 8 },
  ];

  it("首根真实波幅退化为 high - low", () => {
    expect(trueRangeSeries(bars)[0]).toBe(2);
  });

  it("真实波幅取三者最大：本根振幅、与昨收的上下跳空", () => {
    // 第 2 根：max(12-9, |12-9|, |9-9|) = 3
    expect(trueRangeSeries(bars)[1]).toBe(3);
    // 第 3 根：max(11-7, |11-11|, |7-11|) = 4
    expect(trueRangeSeries(bars)[2]).toBe(4);
  });

  it("ATR 是真实波幅的 Wilder 平滑", () => {
    const tr = trueRangeSeries(bars);
    expect(atrSeries(bars, 3)).toEqual(rmaSeries(tr, 3));
  });

  it("ATR 恒为非负", () => {
    const out = atrSeries(bars, 2);
    for (const v of out) {
      if (v != null) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("crossSeries", () => {
  it("上穿与下穿都记 true，首根恒为 false", () => {
    const a = [1, 3, 3, 1];
    const b = [2, 2, 2, 2];
    expect(crossSeries(a, b)).toEqual([false, true, false, true]);
  });

  it("同侧运行始终不算穿越", () => {
    expect(crossSeries([1, 1.5, 1.8], [2, 2, 2])).toEqual([false, false, false]);
  });

  it("触碰后反向离开算穿越（Pine 用 <= / >= 而非严格不等）", () => {
    expect(crossSeries([1, 2, 1], [2, 2, 2])).toEqual([false, false, true]);
  });

  it("从相等处上穿算 true（crossover 用 a[1] <= b[1]）", () => {
    expect(crossSeries([2, 3], [2, 2])).toEqual([false, true]);
  });

  it("任一端为 null 时记 false", () => {
    expect(crossSeries([null, 3, 1], [2, 2, 2])).toEqual([false, false, true]);
  });
});

describe("barsSinceSeries", () => {
  it("条件为真的当根记 0，其后逐根递增", () => {
    expect(barsSinceSeries([false, true, false, false, true, false])).toEqual([
      null,
      0,
      1,
      2,
      0,
      1,
    ]);
  });

  it("从未为真时全为 null（对应 Pine 的 na）", () => {
    expect(barsSinceSeries([false, false, false])).toEqual([null, null, null]);
  });
});
