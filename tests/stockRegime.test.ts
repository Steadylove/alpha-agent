import { type RegimeBar, computeStockRegimeSeries } from "@/lib/scoring/stockRegime";
import { describe, expect, it } from "vitest";

function bar(close: number, opts: Partial<RegimeBar> = {}): RegimeBar {
  return {
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000_000,
    ...opts,
  };
}

const trending = (n: number) => Array.from({ length: n }, (_, i) => bar(100 * 1.003 ** i));

/** 锯齿：均值回归的典型形态 */
const sawtooth = (n: number) =>
  Array.from({ length: n }, (_, i) => bar(i % 2 === 0 ? 100 : 102));

describe("Hurst 指数（价格口径，Pine 原样）", () => {
  it("窗口不足 30 根时返回中性 0.5", () => {
    const days = computeStockRegimeSeries(trending(40));
    expect(days.slice(0, 29).every((d) => d.hurstPrice === 0.5)).toBe(true);
    expect(days[29].hurstPrice).not.toBe(0.5);
  });

  it("单边趋势的 H 高于锯齿震荡的 H", () => {
    const trend = computeStockRegimeSeries(trending(100)).at(-1)!.hurstPrice;
    const chop = computeStockRegimeSeries(sawtooth(100)).at(-1)!.hurstPrice;
    expect(trend).toBeGreaterThan(chop);
  });

  it("单边趋势判为强趋势态", () => {
    expect(computeStockRegimeSeries(trending(100)).at(-1)!.hurstPriceRegime).toBe("trending");
  });

  it("锯齿震荡判为均值回归", () => {
    expect(computeStockRegimeSeries(sawtooth(100)).at(-1)!.hurstPriceRegime).toBe("reverting");
  });

  it("恒定价格标准差为 0，退化为 0.5", () => {
    const flat = Array.from({ length: 50 }, () => bar(100));
    expect(computeStockRegimeSeries(flat).at(-1)!.hurstPrice).toBe(0.5);
  });
});

describe("Hurst 指数（收益率口径，面板采用）", () => {
  it("价格纹丝不动时收益率全为 0，退化为 0.5", () => {
    const flat = Array.from({ length: 60 }, () => bar(100));
    expect(computeStockRegimeSeries(flat).at(-1)!.hurstReturn).toBe(0.5);
  });

  it("不随价格水平漂移：同一涨幅序列平移后 H 不变", () => {
    const a = computeStockRegimeSeries(sawtooth(100)).at(-1)!.hurstReturn;
    const b = computeStockRegimeSeries(
      Array.from({ length: 100 }, (_, i) => bar(i % 2 === 0 ? 1000 : 1020)),
    ).at(-1)!.hurstReturn;
    expect(a).toBeCloseTo(b, 8);
  });

  it("收益率正负交替（反持续）判为均值回归", () => {
    expect(computeStockRegimeSeries(sawtooth(100)).at(-1)!.hurstReturnRegime).toBe("reverting");
  });

  it("收益率成段同号（持续）时高于交替时", () => {
    // 每 10 根同向，收益率自相关为正
    const streaky = Array.from({ length: 100 }, (_, i) => {
      const dir = Math.floor(i / 10) % 2 === 0 ? 1 : -1;
      return 100 * (1 + dir * 0.01) ** i;
    }).map((c) => bar(c));
    const streakH = computeStockRegimeSeries(streaky).at(-1)!.hurstReturn;
    const altH = computeStockRegimeSeries(sawtooth(100)).at(-1)!.hurstReturn;
    expect(streakH).toBeGreaterThan(altH);
  });

  it("首根收益率是构造出来的，因此预热比价格口径晚一根", () => {
    const days = computeStockRegimeSeries(sawtooth(60));
    expect(days[29].hurstReturn).toBe(0.5);
    expect(days[30].hurstReturn).not.toBe(0.5);
  });

  it("两个口径都恒在 0~1 之间", () => {
    for (const bars of [trending(200), sawtooth(200)]) {
      for (const d of computeStockRegimeSeries(bars)) {
        for (const h of [d.hurstPrice, d.hurstReturn]) {
          expect(h).toBeGreaterThanOrEqual(0);
          expect(h).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("两个口径共用同一组态别阈值：>=0.55 趋势、<=0.45 回归", () => {
    for (const d of computeStockRegimeSeries(sawtooth(100))) {
      const expected = (h: number) => (h >= 0.55 ? "trending" : h <= 0.45 ? "reverting" : "random");
      expect(d.hurstPriceRegime).toBe(expected(d.hurstPrice));
      expect(d.hurstReturnRegime).toBe(expected(d.hurstReturn));
    }
  });
});

describe("NR7 与 VCP", () => {
  it("真实波幅为近 7 根最小时判定 NR7", () => {
    const bars = Array.from({ length: 20 }, () => bar(100, { high: 105, low: 95 }));
    bars[19] = { open: 100, high: 100.1, low: 99.9, close: 100, volume: 1e6 };
    expect(computeStockRegimeSeries(bars).at(-1)!.isNr7).toBe(true);
  });

  it("波幅最大的一根不是 NR7", () => {
    const bars = Array.from({ length: 20 }, () => bar(100, { high: 101, low: 99 }));
    bars[19] = { open: 100, high: 130, low: 70, close: 100, volume: 1e6 };
    expect(computeStockRegimeSeries(bars).at(-1)!.isNr7).toBe(false);
  });

  it("波幅逐级收敛时判定 VCP", () => {
    // 波幅从 20% 一路缩到 0.4%
    const bars = Array.from({ length: 60 }, (_, i) => {
      const w = Math.max(0.002, 0.1 * (1 - i / 60));
      return { open: 100, high: 100 * (1 + w), low: 100 * (1 - w), close: 100, volume: 1e6 };
    });
    expect(computeStockRegimeSeries(bars).at(-1)!.isVcp).toBe(true);
  });

  it("波幅逐级放大时不是 VCP", () => {
    const bars = Array.from({ length: 60 }, (_, i) => {
      const w = 0.002 + 0.1 * (i / 60);
      return { open: 100, high: 100 * (1 + w), low: 100 * (1 - w), close: 100, volume: 1e6 };
    });
    expect(computeStockRegimeSeries(bars).at(-1)!.isVcp).toBe(false);
  });

  it("孕线在既非 NR7 也非 VCP 时才显示", () => {
    // 前 13 根极窄，第 14 根暴涨拉宽，末根被包在里面但仍远宽于前面那批
    const bars: RegimeBar[] = Array.from({ length: 13 }, () => ({
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
      volume: 1e6,
    }));
    bars.push({ open: 100, high: 110, low: 90, close: 100, volume: 1e6 });
    bars.push({ open: 100, high: 105, low: 95, close: 100, volume: 1e6 });

    const last = computeStockRegimeSeries(bars).at(-1)!;
    expect(last.isNr7).toBe(false);
    expect(last.isVcp).toBe(false);
    expect(last.volatilityPattern).toBe("inside_bar");
  });

  it("NR7 与 VCP 同时成立时合并为引爆态", () => {
    const bars = Array.from({ length: 60 }, (_, i) => {
      const w = Math.max(0.001, 0.1 * (1 - i / 60));
      return { open: 100, high: 100 * (1 + w), low: 100 * (1 - w), close: 100, volume: 1e6 };
    });
    const last = computeStockRegimeSeries(bars).at(-1)!;
    expect(last.isNr7 && last.isVcp).toBe(true);
    expect(last.volatilityPattern).toBe("vcp_nr7");
  });
});

describe("量能与资金态", () => {
  it("放量倍数相对 50 日均量计算", () => {
    const bars = Array.from({ length: 60 }, () => bar(100, { volume: 1_000_000 }));
    bars[59] = bar(100, { volume: 3_000_000 });
    // 50 日均量窗口含末根自身：(49×1M + 3M)/50 = 1.04M
    expect(computeStockRegimeSeries(bars).at(-1)!.volumeRatio).toBeCloseTo(3 / 1.04, 6);
  });

  it("均量窗口不足时倍数退化为 1", () => {
    expect(computeStockRegimeSeries(trending(10))[0].volumeRatio).toBe(1);
  });

  it("缩量到均量 45% 以下判为极度锁仓", () => {
    const bars = Array.from({ length: 60 }, () => bar(100, { volume: 1_000_000 }));
    bars[59] = { open: 100, high: 101, low: 99, close: 99, volume: 100_000 };
    expect(computeStockRegimeSeries(bars).at(-1)!.moneyFlow).toBe("dry_up");
  });

  it("上涨放量突破近 10 日最大下跌量时触发 Pocket Pivot", () => {
    // 先造一段温和上涨确立均线，再插入一根大跌，最后一根放量收复
    const bars = Array.from({ length: 60 }, (_, i) => bar(100 + i * 0.2, { volume: 1_000_000 }));
    bars[55] = { open: 111, high: 111, low: 108, close: 108, volume: 1_500_000 };
    const last = 112;
    bars[59] = { open: 109, high: 113, low: 109, close: last, volume: 5_000_000 };
    const day = computeStockRegimeSeries(bars).at(-1)!;
    expect(day.isPocketPivot).toBe(true);
    expect(day.moneyFlow).toBe("pocket_pivot");
  });

  it("下跌日不会触发 Pocket Pivot，哪怕成交量巨大", () => {
    const bars = Array.from({ length: 60 }, (_, i) => bar(100 + i * 0.2, { volume: 1_000_000 }));
    bars[59] = { open: 112, high: 112, low: 100, close: 100, volume: 9_000_000 };
    expect(computeStockRegimeSeries(bars).at(-1)!.isPocketPivot).toBe(false);
  });

  it("OBV 在均线上方为净流入，下方为净流出", () => {
    const up = computeStockRegimeSeries(trending(80)).at(-1)!;
    expect(up.moneyFlow === "inflow" || up.moneyFlow === "pocket_pivot").toBe(true);

    const down = Array.from({ length: 80 }, (_, i) => bar(100 * 0.997 ** i));
    expect(computeStockRegimeSeries(down).at(-1)!.moneyFlow).toBe("outflow");
  });
});

describe("边界", () => {
  it("空输入返回空数组", () => {
    expect(computeStockRegimeSeries([])).toEqual([]);
  });

  it("单根输入不抛错", () => {
    expect(computeStockRegimeSeries([bar(100)])).toHaveLength(1);
  });
});
