import {
  PERCENTILE_RS_TERMS,
  UNRANKED,
  alphaScoreAt,
  crossSectionalRs,
  percentileRank,
  percentileRsBySymbol,
} from "@/lib/scoring/percentileRs";
import { describe, expect, it } from "vitest";

function ramp(n: number, dailyPct: number, start = 100): number[] {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i += 1) {
    v *= 1 + dailyPct / 100;
    out.push(v);
  }
  return out;
}

describe("percentileRank", () => {
  it("最强的排最高、最弱的排最低", () => {
    const r = percentileRank([10, 20, 30, 40, 50]);
    expect(r.at(-1)!).toBeGreaterThan(r[0]);
    expect(r[0]).toBeLessThan(20);
    expect(r.at(-1)!).toBeGreaterThan(80);
  });

  it("恒在 1~99 之间", () => {
    for (const v of percentileRank([-100, 0, 1, 1, 1, 999])) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(99);
    }
  });

  it("全体同分时每只都得 50，而非全 1 或全 99", () => {
    expect(percentileRank([7, 7, 7, 7])).toEqual([50, 50, 50, 50]);
  });

  it("并列取中位排名", () => {
    // [1, 2, 2, 3]：两个 2 各有 1 个低于自己、2 个并列 → (1+1)/4 = 50
    const r = percentileRank([1, 2, 2, 3]);
    expect(r[1]).toBeCloseTo(50, 10);
    expect(r[2]).toBeCloseTo(50, 10);
  });

  it("单元素返回 50，空数组返回空", () => {
    expect(percentileRank([42])).toEqual([50]);
    expect(percentileRank([])).toEqual([]);
  });

  it("同样的绝对表现，在更强的池子里得分更低——这正是与饱和映射的本质差别", () => {
    const weakPool = percentileRank([50, 10, 12, 15]);
    const strongPool = percentileRank([50, 80, 90, 95]);
    expect(weakPool[0]).toBeGreaterThan(strongPool[0]);
  });
});

describe("公式常量对齐策略规格「阶段二」", () => {
  it("四段回看为 21/63/126/252，权重 .10/.40/.30/.20", () => {
    expect(PERCENTILE_RS_TERMS).toEqual([
      { lookback: 21, weight: 0.1 },
      { lookback: 63, weight: 0.4 },
      { lookback: 126, weight: 0.3 },
      { lookback: 252, weight: 0.2 },
    ]);
  });

  it("权重之和为 1，因此走平的标的恰好得 100", () => {
    const sum = PERCENTILE_RS_TERMS.reduce((a, t) => a + t.weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe("alphaScoreAt", () => {
  it("横盘不动得 100", () => {
    expect(alphaScoreAt(new Array(400).fill(50), 399)).toBeCloseTo(100, 10);
  });

  it("上涨高于 100、下跌低于 100（绝对涨幅口径，不除基准）", () => {
    expect(alphaScoreAt(ramp(400, 0.3), 399)).toBeGreaterThan(100);
    expect(alphaScoreAt(ramp(400, -0.1), 399)).toBeLessThan(100);
  });

  it("逐项等于 .10×Perf21 + .40×Perf63 + .30×Perf126 + .20×Perf252", () => {
    // 恒定日涨幅 r 下 close[i]/close[i-L] = (1+r)^L，可解析地写出期望值
    const r = 0.002;
    const closes = ramp(400, r * 100);
    const g = (l: number) => (1 + r) ** l;
    const want = 100 * (0.1 * g(21) + 0.4 * g(63) + 0.3 * g(126) + 0.2 * g(252));

    expect(alphaScoreAt(closes, 399)).toBeCloseTo(want, 6);
  });

  it("四段都是累计区间涨幅，不是各区间的分段涨幅", () => {
    // 前 380 根横盘、最后 21 根上涨。四段的基期都落在横盘段上（同为 100），
    // 累计口径下四项因此相等，总分正好等于这波涨幅；
    // 分段口径下只有 Perf21 能反映它，其余三段都会退化成 1，总分明显更低。
    const closes = [...new Array(380).fill(100), ...ramp(21, 0.5)];
    const at = closes.length - 1;
    const gain = closes[at] / 100;

    const cumulative = 100 * gain;
    const segmented = 100 * (0.1 * gain + 0.4 + 0.3 + 0.2);

    expect(alphaScoreAt(closes, at)).toBeCloseTo(cumulative, 6);
    expect(cumulative).toBeGreaterThan(segmented);
  });

  it("规格里的 Perf 口径与实现的涨幅比口径恒差常数 100，截面排名一致", () => {
    const perfScore = (closes: readonly number[], at: number) =>
      PERCENTILE_RS_TERMS.reduce(
        (s, t) => s + t.weight * (closes[at] / closes[at - t.lookback] - 1) * 100,
        0,
      );

    for (const daily of [0.3, -0.1, 0.02]) {
      const closes = ramp(400, daily);
      expect(alphaScoreAt(closes, 399) - perfScore(closes, 399)).toBeCloseTo(100, 6);
    }
  });
});

describe("alphaScoreAt 的预热语义", () => {
  it("回看落空返回 NaN，而不是把缺失段当成走平", () => {
    const closes = ramp(400, 0.3);

    expect(Number.isNaN(alphaScoreAt(closes, 251))).toBe(true);
    expect(Number.isNaN(alphaScoreAt(closes, 252))).toBe(false);
  });

  it("回看未齐的标的不进截面，不会抬高分母压低他人分位", () => {
    // 两只满预热 + 一只未满：未满的那只应记 UNRANKED，
    // 另两只的分位应与「只有它们两只」时完全一致
    const full = [
      { closes: ramp(400, 0.3), index: 399 },
      { closes: ramp(400, 0.1), index: 399 },
    ];
    const withWarmup = crossSectionalRs([...full, { closes: ramp(400, 0.2), index: 10 }]);
    const without = crossSectionalRs(full);

    expect(withWarmup[2]).toBe(UNRANKED);
    expect(withWarmup[0]).toBe(without[0]);
    expect(withWarmup[1]).toBe(without[1]);
  });
});

describe("crossSectionalRs", () => {
  it("按全池相对强弱排序，返回值与入参同序", () => {
    const rs = crossSectionalRs([
      { closes: ramp(400, -0.2), index: 399 },
      { closes: ramp(400, 0.05), index: 399 },
      { closes: ramp(400, 0.4), index: 399 },
    ]);
    expect(rs).toHaveLength(3);
    expect(rs[2]).toBeGreaterThan(rs[1]);
    expect(rs[1]).toBeGreaterThan(rs[0]);
  });
});

describe("percentileRsBySymbol", () => {
  const dates = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `d${String(i + from).padStart(4, "0")}`);

  it("每只标的返回与自身序列等长的 RS", () => {
    const out = percentileRsBySymbol([
      { symbol: "A", dates: dates(400), closes: ramp(400, 0.3) },
      { symbol: "B", dates: dates(400), closes: ramp(400, -0.1) },
    ]);
    expect(out.get("A")).toHaveLength(400);
    expect(out.get("B")).toHaveLength(400);
    expect(out.get("A")!.at(-1)!).toBeGreaterThan(out.get("B")!.at(-1)!);
  });

  it("按日期而非下标对齐——上市晚的标的不会错位到别人的日期上", () => {
    // late 从第 200 个交易日才开始，若按下标对齐会把它当成从第 0 日起算
    const late = { symbol: "LATE", dates: dates(200, 200), closes: ramp(200, 0.3) };
    const full = { symbol: "FULL", dates: dates(400), closes: ramp(400, 0.1) };

    const out = percentileRsBySymbol([full, late]);
    expect(out.get("LATE")).toHaveLength(200);
    expect(out.get("FULL")).toHaveLength(400);
    // late 全程不满 252 根，一天都不该被评分
    expect(out.get("LATE")!.every((v) => v === UNRANKED)).toBe(true);
  });

  it("某日只有一只标的有数据时该日记 50，而非 1 或 99", () => {
    const solo = { symbol: "SOLO", dates: dates(400), closes: ramp(400, 0.3) };
    const late = { symbol: "LATE", dates: dates(1, 399), closes: [100] };

    const out = percentileRsBySymbol([solo, late]);
    // 取 300 而非 100：252 日回看要满 252 根才给分，下标 100 仍在预热期
    expect(out.get("SOLO")![300]).toBe(50);
  });

  it("四段回看未齐时记 UNRANKED，不按走平计入", () => {
    const a = { symbol: "A", dates: dates(400), closes: ramp(400, 0.3) };
    const b = { symbol: "B", dates: dates(400), closes: ramp(400, 0.1) };
    const out = percentileRsBySymbol([a, b]);

    // 满 252 根之前一律不评分
    expect(out.get("A")![251]).toBe(UNRANKED);
    expect(out.get("A")![252]).toBeGreaterThan(UNRANKED);
    // 预热结束后强者仍在弱者之上，说明排名本身没被破坏
    expect(out.get("A")!.at(-1)!).toBeGreaterThan(out.get("B")!.at(-1)!);
  });
});
