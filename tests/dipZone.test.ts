import { type DipZoneInput, computeDipZone } from "@/lib/scoring/dipZone";
import { describe, expect, it } from "vitest";

const base: DipZoneInput = {
  close: 100,
  atr: 3,
  stage: "B",
  trendScore: 8,
  volumeRatio: 1,
  pathId: 0,
  ema20: 97,
  ema50: 93,
  ema576: 70,
  vwap90: 95,
  vwap250: 88,
  ema144: 90,
  ema169: 89,
};

const at = (over: Partial<DipZoneInput>) => computeDipZone({ ...base, ...over });

describe("大盘闸门", () => {
  it("Path 4 一律冻结低吸，不分阶段", () => {
    for (const stage of ["A", "B", "C", "D", "E", "W"] as const) {
      expect(at({ stage, pathId: 4 })).toEqual({ kind: "frozen" });
    }
  });

  it("Path 0~3 不冻结", () => {
    for (const pathId of [0, 1, 2, 3]) {
      expect(at({ pathId }).kind).not.toBe("frozen");
    }
  });
});

describe("Stage A 黄金突破带", () => {
  it("锚在 max(EMA20, VWAP90) 上，上沿加 0.3 ATR 缓冲", () => {
    const zone = at({ stage: "A" });
    expect(zone).toMatchObject({ kind: "range", quality: "prime" });
    if (zone.kind !== "range") throw new Error("unreachable");
    // base = min(100, max(97, 95)) = 97；high = min(100, 97+0.9) = 97.9
    expect(zone.high).toBeCloseTo(97.9, 10);
    // low = min(97.9×0.98, 97−3) = min(95.942, 94) = 94
    expect(zone.low).toBeCloseTo(94, 10);
  });

  it("上沿不会超过当日收盘价", () => {
    const zone = at({ stage: "A", ema20: 999, vwap90: 999 });
    if (zone.kind !== "range") throw new Error("unreachable");
    expect(zone.high).toBeLessThanOrEqual(100);
  });
});

describe("Stage B 箱体蓄势", () => {
  it("趋势分 >=7 时用 EMA20 作上沿", () => {
    const zone = at({ stage: "B", trendScore: 7 });
    if (zone.kind !== "range") throw new Error("unreachable");
    expect(zone.high).toBeCloseTo(97, 10);
    // base = min(100, max(93, 89)) = 93；low = min(97×0.97, 93−3.6) = min(94.09, 89.4)
    expect(zone.low).toBeCloseTo(89.4, 10);
  });

  it("趋势分 <7 时改用更低的 min(EMA50, Vegas上沿) 作上沿", () => {
    const strong = at({ stage: "B", trendScore: 7 });
    const weak = at({ stage: "B", trendScore: 6 });
    if (strong.kind !== "range" || weak.kind !== "range") throw new Error("unreachable");
    expect(weak.high).toBeLessThan(strong.high);
    expect(weak.quality).toBe("normal");
  });

  it("强趋势且缩量到均量五成以下时标为量能枯竭", () => {
    expect(at({ stage: "B", trendScore: 8, volumeRatio: 0.4 })).toMatchObject({
      quality: "dry_up",
    });
    expect(at({ stage: "B", trendScore: 8, volumeRatio: 0.5 })).toMatchObject({
      quality: "prime",
    });
  });

  it("缩量标记只在强趋势档生效", () => {
    expect(at({ stage: "B", trendScore: 6, volumeRatio: 0.1 })).toMatchObject({
      quality: "normal",
    });
  });
});

describe("Stage E 混沌筑底", () => {
  it("带子整体位于 Stage A 之下，且下沿留 1.5 ATR 深缓冲", () => {
    const e = at({ stage: "E" });
    const a = at({ stage: "A" });
    if (e.kind !== "range" || a.kind !== "range") throw new Error("unreachable");
    expect(e.high).toBeLessThan(a.high);
    // base = min(100, min(95, 90)) = 90；low = min(90×0.92, max(70, 79.2)−4.5)
    expect(e.high).toBeCloseTo(90, 10);
    expect(e.low).toBeCloseTo(74.7, 10);
    expect(e.quality).toBe("bottom");
  });
});

describe("Stage W / D / C", () => {
  it("Stage W 只给当前价下方的震荡箱体", () => {
    expect(at({ stage: "W" })).toEqual({
      kind: "range",
      low: 100 - 4.5,
      high: 100 - 0.6,
      quality: "choppy",
    });
  });

  it("Stage D 不给买点，只标 VWAP90 压制位", () => {
    expect(at({ stage: "D" })).toEqual({ kind: "avoid", resistance: 95 });
  });

  it("Stage C 判定为安全垫失效", () => {
    expect(at({ stage: "C" })).toEqual({ kind: "overextended" });
  });
});

describe("均线缺失兜底", () => {
  it("预热期均线为 null 时用收盘价顶替，不产生 NaN", () => {
    const zone = at({
      stage: "A",
      ema20: null,
      ema50: null,
      ema576: null,
      vwap90: null,
      vwap250: null,
      ema144: null,
      ema169: null,
    });
    if (zone.kind !== "range") throw new Error("unreachable");
    expect(Number.isFinite(zone.low)).toBe(true);
    expect(Number.isFinite(zone.high)).toBe(true);
  });
});

describe("区间不变量", () => {
  it("所有 range 结果都满足 low < high 且 high <= close", () => {
    for (const stage of ["A", "B", "E", "W"] as const) {
      for (const trendScore of [2, 7]) {
        const zone = at({ stage, trendScore });
        if (zone.kind !== "range") continue;
        expect(zone.low).toBeLessThan(zone.high);
        expect(zone.high).toBeLessThanOrEqual(base.close);
      }
    }
  });
});
