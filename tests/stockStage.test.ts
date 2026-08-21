import {
  type StageBar,
  computeStockStageSeries,
  institutionalVwap,
} from "@/lib/scoring/stockStage";
import { describe, expect, it } from "vitest";

/** 构造一段带日内幅度的行情，dailyPct 为每日收盘涨幅。 */
function makeBars(n: number, dailyPct: number, start = 100): StageBar[] {
  const out: StageBar[] = [];
  let close = start;
  for (let i = 0; i < n; i += 1) {
    close = close * (1 + dailyPct / 100);
    out.push({
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
    });
  }
  return out;
}

const flatRs = (n: number, v: number) => new Array(n).fill(v);

describe("T-CUBE 趋势打分卡", () => {
  it("完美多头排列且均线上行时满分 10", () => {
    const bars = makeBars(400, 0.3);
    const last = computeStockStageSeries(bars, flatRs(400, 60)).at(-1)!;
    expect(last.trendScore).toBe(10);
  });

  it("长期单边下跌时得 0 分", () => {
    const bars = makeBars(400, -0.3);
    const last = computeStockStageSeries(bars, flatRs(400, 20)).at(-1)!;
    expect(last.trendScore).toBe(0);
  });

  it("评分恒在 0~10 之间", () => {
    const bars = makeBars(400, 0.05);
    for (const day of computeStockStageSeries(bars, flatRs(400, 50))) {
      expect(day.trendScore).toBeGreaterThanOrEqual(0);
      expect(day.trendScore).toBeLessThanOrEqual(10);
    }
  });
});

describe("6 大形态阶段闸", () => {
  it("52 周高点不含当日，稳步上涨的股票 dist 只等于单日涨幅", () => {
    // Pine 用 ta.highest(close[1], 252)，对单调上涨序列该值就是昨收，
    // 于是 dist_52w ≈ 当日涨幅，Stage C 的 +18% 门槛实际上够不到。
    const bars = makeBars(400, 0.3);
    const last = computeStockStageSeries(bars, flatRs(400, 90)).at(-1)!;
    expect(last.distFrom52wHigh).toBeCloseTo(0.3, 6);
    expect(last.stage).not.toBe("C");
  });

  it("只有单日暴涨 18% 以上才触发 Stage C", () => {
    const bars = makeBars(400, 0.3);
    const jump = bars[399].close * 1.25;
    bars[399] = { high: jump * 1.01, low: jump * 0.99, close: jump, volume: 1e6 };
    const last = computeStockStageSeries(bars, flatRs(400, 90)).at(-1)!;
    expect(last.distFrom52wHigh).toBeGreaterThan(18);
    expect(last.stage).toBe("C");
  });

  it("跌破 EMA200 且趋势分低、VWAP 下行时为 Stage D", () => {
    const bars = makeBars(400, -0.3);
    const last = computeStockStageSeries(bars, flatRs(400, 15)).at(-1)!;
    expect(last.stage).toBe("D");
  });

  it("涨到 52 周高点附近且趋势强时为 Stage A（黄金突破带）", () => {
    // 先横盘筑底 300 根，再用 20 根小步走回前高附近
    const bars: StageBar[] = [];
    for (let i = 0; i < 300; i += 1) {
      const close = 100 + Math.sin(i / 9) * 1.5;
      bars.push({ high: close * 1.01, low: close * 0.99, close, volume: 1e6 });
    }
    for (let i = 0; i < 60; i += 1) {
      const close = 100 + i * 0.03;
      bars.push({ high: close * 1.01, low: close * 0.99, close, volume: 1e6 });
    }
    const last = computeStockStageSeries(bars, flatRs(bars.length, 80)).at(-1)!;
    expect(last.distFrom52wHigh).toBeGreaterThanOrEqual(-8);
    expect(last.distFrom52wHigh).toBeLessThanOrEqual(6);
    expect(last.stage).toBe("A");
  });

  it("每一根都恰好落在 6 个阶段之一", () => {
    const valid = new Set(["A", "B", "C", "D", "E", "W"]);
    for (const pct of [0.3, -0.3, 0.02]) {
      for (const day of computeStockStageSeries(makeBars(400, pct), flatRs(400, 50))) {
        expect(valid.has(day.stage)).toBe(true);
      }
    }
  });

  it("Stage C 优先级高于 Stage A（Pine 第 302 行的嵌套顺序）", () => {
    // 同一根上 A 与 C 的条件都想成立时，C 赢：is_stage_a 里显式排除了 C
    const bars = makeBars(400, 0.3);
    expect(computeStockStageSeries(bars, flatRs(400, 90)).at(-1)!.stage).toBe("A");

    const jump = bars[399].close * 1.25;
    bars[399] = { high: jump * 1.01, low: jump * 0.99, close: jump, volume: 1e6 };
    expect(computeStockStageSeries(bars, flatRs(400, 90)).at(-1)!.stage).toBe("C");
  });
});

describe("筑底天数与档位", () => {
  it("从未跌破 EMA50×0.85 时记 30 天，落在 T2", () => {
    const first = computeStockStageSeries(makeBars(400, 0.3), flatRs(400, 60))[0];
    expect(first.baseDays).toBe(30);
    expect(first.baseTier).toBe("T2");
  });

  it("跌破当日归零并逐日累加", () => {
    const bars = makeBars(300, 0.3);
    // 只砸第 250 根，把价格打到 EMA50 的 85% 以下，次日即恢复
    bars[250] = { ...bars[250], close: bars[250].close * 0.5, low: bars[250].close * 0.49 };
    const days = computeStockStageSeries(bars, flatRs(300, 40));
    expect(days[250].baseDays).toBe(0);
    expect(days[251].baseDays).toBe(1);
    expect(days[260].baseDays).toBe(10);
  });

  it("档位边界：<15 为 T1，15~65 为 T2，>65 为 T3", () => {
    const bars = makeBars(300, 0.3);
    for (let i = 100; i < 101; i += 1) {
      bars[i] = { ...bars[i], close: bars[i].close * 0.5 };
    }
    const days = computeStockStageSeries(bars, flatRs(300, 40));
    expect(days[100 + 14].baseTier).toBe("T1");
    expect(days[100 + 15].baseTier).toBe("T2");
    expect(days[100 + 65].baseTier).toBe("T2");
    expect(days[100 + 66].baseTier).toBe("T3");
  });
});

describe("挤压比率", () => {
  it("恒定价格时布林带宽为 0，比率为 0", () => {
    const bars: StageBar[] = new Array(300).fill(null).map(() => ({
      high: 101,
      low: 99,
      close: 100,
      volume: 1e6,
    }));
    expect(computeStockStageSeries(bars, flatRs(300, 50)).at(-1)!.squeezeRatio).toBeCloseTo(0, 8);
  });

  it("预热期缺 ATR 时退化为 1（Pine 的 nz 兜底）", () => {
    expect(computeStockStageSeries(makeBars(400, 0.1), flatRs(400, 50))[0].squeezeRatio).toBe(1);
  });
});

describe("institutionalVwap", () => {
  it("成交量恒定时等于收盘价均线", () => {
    const bars = [
      { close: 10, volume: 100 },
      { close: 20, volume: 100 },
      { close: 30, volume: 100 },
    ];
    expect(institutionalVwap(bars, 3)[2]).toBeCloseTo(20, 10);
  });

  it("按成交量加权而非等权", () => {
    const bars = [
      { close: 10, volume: 1 },
      { close: 20, volume: 1 },
      { close: 30, volume: 100 },
    ];
    expect(institutionalVwap(bars, 3)[2]!).toBeGreaterThan(29);
  });

  it("零成交量时退化为收盘价均线而非 NaN", () => {
    const bars = [
      { close: 10, volume: 0 },
      { close: 20, volume: 0 },
      { close: 30, volume: 0 },
    ];
    expect(institutionalVwap(bars, 3)[2]).toBeCloseTo(20, 10);
  });
});

describe("入参校验", () => {
  it("RS 序列与 K 线长度不一致时抛错", () => {
    expect(() => computeStockStageSeries(makeBars(10, 1), flatRs(9, 50))).toThrow(/长度不一致/);
  });

  it("空输入返回空数组", () => {
    expect(computeStockStageSeries([], [])).toEqual([]);
  });
});
