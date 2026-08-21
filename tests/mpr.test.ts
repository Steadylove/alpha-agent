import { MPR_DEFAULTS, computeMprSeries, rollingEcdf, type MprInput } from "@/lib/scoring/mpr";
import { describe, expect, it } from "vitest";

/** 确定性伪随机，保证夹具可复现。 */
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/**
 * 带噪声的常态行情夹具。
 *
 * 不能用恒定序列：percentrank 统计的是 <=，一条纹丝不动的序列会让所有历史值都
 * 「小于等于」当前值，ECDF 直接读满 100（见下面的退化性质测试）。真实行情不存在
 * 这种情况，但合成数据很容易踩到。
 */
function makeMarketInput(days: number, seed = 42): MprInput[] {
  const r = lcg(seed);
  let spy = 100;
  let rsp = 100;
  let tlt = 100;
  let dxy = 100;
  let hyg = 100;
  let iei = 100;

  return Array.from({ length: days }, (_, i) => {
    spy *= 1 + (r() - 0.45) * 0.01;
    rsp *= 1 + (r() - 0.45) * 0.01;
    tlt *= 1 + (r() - 0.5) * 0.008;
    dxy *= 1 + (r() - 0.5) * 0.004;
    hyg *= 1 + (r() - 0.48) * 0.005;
    iei *= 1 + (r() - 0.5) * 0.002;
    const vix = 13 + r() * 4;

    return {
      date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      spyClose: spy,
      spyVolume: 70_000_000 + r() * 20_000_000,
      rspClose: rsp,
      tltClose: tlt,
      dxyClose: dxy,
      hygClose: hyg,
      ieiClose: iei,
      vixClose: vix,
      vix9dClose: vix * (0.85 + r() * 0.1),
      vix3mClose: vix * (1.1 + r() * 0.1),
    };
  });
}

/** 所有序列恒定的退化夹具，只用于验证 ECDF 的边界性质。 */
function makeFlatInput(days: number): MprInput[] {
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    spyClose: 100 + i * 0.1,
    spyVolume: 80_000_000,
    rspClose: 100 + i * 0.1,
    tltClose: 100,
    dxyClose: 100,
    hygClose: 100,
    ieiClose: 100,
    vixClose: 14,
    vix9dClose: 13,
    vix3mClose: 16,
  }));
}

describe("rollingEcdf", () => {
  it("na 源值先填 0，percentrank 的 na 结果后填 50", () => {
    // 前 3 位不足窗口 -> percentrank 为 null -> 填 50
    const out = rollingEcdf([null, null, null, 1, 2], 3);
    expect(out.slice(0, 3)).toEqual([50, 50, 50]);
    // i=3：源被填成 [0,0,0]，当前值 1，窗口 [0,0,0] 全 <=1 -> 100
    expect(out[3]).toBeCloseTo(100, 10);
  });

  it("非有限值（NaN/Infinity）与 null 同样填 0", () => {
    const out = rollingEcdf([Number.NaN, Number.POSITIVE_INFINITY, 0, -1], 3);
    // i=3：源被填成 [0,0,0]，当前 -1，窗口无一 <= -1 -> 0
    expect(out[3]).toBeCloseTo(0, 10);
  });
});

describe("computeMprSeries 基本契约", () => {
  it("输出长度与输入一致", () => {
    expect(computeMprSeries(makeMarketInput(300))).toHaveLength(300);
  });

  it("date 原样透传且顺序不变", () => {
    const rows = makeMarketInput(50);
    expect(computeMprSeries(rows).map((d) => d.date)).toEqual(rows.map((r) => r.date));
  });

  it("五力场输出恒在 0~100 区间", () => {
    for (const day of computeMprSeries(makeMarketInput(600))) {
      for (const v of [day.f1, day.f2, day.f3, day.f4, day.f5]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it("风险分被夹在 5~100", () => {
    for (const day of computeMprSeries(makeMarketInput(600))) {
      expect(day.marketRiskScore).toBeGreaterThanOrEqual(5);
      expect(day.marketRiskScore).toBeLessThanOrEqual(100);
    }
  });

  it("概率恒在 0~100 且无 NaN", () => {
    for (const day of computeMprSeries(makeMarketInput(600))) {
      expect(Number.isFinite(day.prob5dDown)).toBe(true);
      expect(day.prob5dDown).toBeGreaterThan(0);
      expect(day.prob5dDown).toBeLessThan(100);
    }
  });

  it("参数可覆盖 calibLen", () => {
    const series = computeMprSeries(makeMarketInput(200), { ...MPR_DEFAULTS, calibLen: 60 });
    expect(series).toHaveLength(200);
  });
});

describe("ECDF 退化性质", () => {
  it("恒定序列会让 ECDF 读满 100（percentrank 计 <= 而非 <）", () => {
    // 这不是移植 bug，Pine 的 ta.percentrank 就是这个语义。
    // 记录在此，避免以后有人看到合成数据里 F3/F4 爆表就去「修」实现。
    const last = computeMprSeries(makeFlatInput(400)).at(-1)!;
    expect(last.f4).toBe(100); // rawCred 恒为 1
    expect(last.f3).toBe(100); // macroBreak 恒为 0
    expect(last.f5).toBe(100); // dispersion 恒为 0
  });
});

describe("F2 阈值滤波", () => {
  it("VIX < 16 时压力被压到 45 以内", () => {
    const rows = makeMarketInput(400).map((r, i) =>
      i > 300 ? { ...r, vix9dClose: 30, vix3mClose: 20, vixClose: 12 } : r,
    );
    expect(computeMprSeries(rows).at(-1)!.f2).toBeLessThanOrEqual(45);
  });

  it("期限比率 < 0.9 时同样被压到 45 以内", () => {
    const rows = makeMarketInput(400).map((r, i) =>
      i > 300 ? { ...r, vix9dClose: 10, vix3mClose: 20, vixClose: 25 } : r,
    );
    const last = computeMprSeries(rows).at(-1)!;
    expect(last.rawTerm).toBeLessThan(0.9);
    expect(last.f2).toBeLessThanOrEqual(45);
  });

  it("倒挂且 VIX 高企时不被压制", () => {
    const rows = makeMarketInput(400).map((r, i) =>
      i > 300 ? { ...r, vix9dClose: 40, vix3mClose: 30, vixClose: 35 } : r,
    );
    const last = computeMprSeries(rows).at(-1)!;
    expect(last.rawTerm).toBeGreaterThan(0.9);
    expect(last.f2).toBeGreaterThan(45);
  });
});
