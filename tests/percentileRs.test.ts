import {
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

describe("alphaScoreAt", () => {
  it("与基准同步时得 100", () => {
    const s = ramp(400, 0.1);
    expect(alphaScoreAt(s, s, 399)).toBeCloseTo(100, 10);
  });

  it("跑赢基准时高于 100", () => {
    expect(alphaScoreAt(ramp(400, 0.3), ramp(400, 0.05), 399)).toBeGreaterThan(100);
  });
});

describe("percentileRsBySymbol", () => {
  const dates = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `d${String(i + from).padStart(4, "0")}`);

  it("每只标的返回与自身序列等长的 RS", () => {
    const bench = { dates: dates(400), closes: ramp(400, 0.05) };
    const out = percentileRsBySymbol(
      [
        { symbol: "A", dates: dates(400), closes: ramp(400, 0.3) },
        { symbol: "B", dates: dates(400), closes: ramp(400, -0.1) },
      ],
      bench,
    );
    expect(out.get("A")).toHaveLength(400);
    expect(out.get("B")).toHaveLength(400);
    expect(out.get("A")!.at(-1)!).toBeGreaterThan(out.get("B")!.at(-1)!);
  });

  it("按日期而非下标对齐——上市晚的标的不会错位到别人的日期上", () => {
    const bench = { dates: dates(400), closes: ramp(400, 0.05) };
    // late 从第 200 个交易日才开始，若按下标对齐会把它当成从第 0 日起算
    const late = { symbol: "LATE", dates: dates(200, 200), closes: ramp(200, 0.3) };
    const full = { symbol: "FULL", dates: dates(400), closes: ramp(400, 0.1) };

    const out = percentileRsBySymbol([full, late], bench);
    expect(out.get("LATE")).toHaveLength(200);
    expect(out.get("FULL")).toHaveLength(400);
  });

  it("某日只有一只标的有数据时该日记 50，而非 1 或 99", () => {
    const bench = { dates: dates(400), closes: ramp(400, 0.05) };
    const solo = { symbol: "SOLO", dates: dates(400), closes: ramp(400, 0.3) };
    const late = { symbol: "LATE", dates: dates(1, 399), closes: [100] };

    const out = percentileRsBySymbol([solo, late], bench);
    // 前 399 日只有 SOLO 在场
    expect(out.get("SOLO")![100]).toBe(50);
  });

  it("基准缺该交易日时保持默认 50，不抛错", () => {
    const bench = { dates: dates(300), closes: ramp(300, 0.05) };
    const out = percentileRsBySymbol(
      [{ symbol: "A", dates: dates(400), closes: ramp(400, 0.3) }],
      bench,
    );
    expect(out.get("A")!.at(-1)).toBe(50);
  });
});

describe("crossSectionalRs", () => {
  it("按全池相对强弱排序，返回值与入参同序", () => {
    const bench = ramp(400, 0.05);
    const universe = [
      { closes: ramp(400, -0.2), index: 399 },
      { closes: ramp(400, 0.05), index: 399 },
      { closes: ramp(400, 0.4), index: 399 },
    ];
    const rs = crossSectionalRs(universe, bench);
    expect(rs).toHaveLength(3);
    expect(rs[2]).toBeGreaterThan(rs[1]);
    expect(rs[1]).toBeGreaterThan(rs[0]);
  });
});
