import {
  type MomentumGateInput,
  computeMomentumGates,
  fourHourAlpha,
} from "@/lib/scoring/momentumGates";
import { describe, expect, it } from "vitest";

const N = 400;

const flat = (v: number, n = N) => new Array(n).fill(v);

const base: MomentumGateInput = {
  closes: flat(100),
  rsRatings: flat(50),
  index: N - 1,
  tfAlpha: 0,
  ema200: 100,
  ema850: 100,
};

const at = (over: Partial<MomentumGateInput>) => computeMomentumGates({ ...base, ...over });

describe("长期下行", () => {
  it("跌破 EMA850 且 RS < 40 才成立", () => {
    expect(at({ closes: flat(90), rsRatings: flat(30), ema850: 100 }).isInLongDowntrend).toBe(true);
  });

  it("只跌破 EMA850 但 RS 不低时不成立", () => {
    expect(at({ closes: flat(90), rsRatings: flat(50), ema850: 100 }).isInLongDowntrend).toBe(
      false,
    );
  });

  it("RS 低但站在 EMA850 上方时不成立", () => {
    expect(at({ closes: flat(110), rsRatings: flat(30), ema850: 100 }).isInLongDowntrend).toBe(
      false,
    );
  });

  it("EMA850 未预热时按现价处理，等价于不跌破", () => {
    expect(at({ rsRatings: flat(30), ema850: null }).isInLongDowntrend).toBe(false);
  });
});

describe("曾经的龙头", () => {
  it("60 日内 RS 峰值达 75 且当前仍在 65 以上时成立", () => {
    const rs = flat(50);
    for (let i = N - 30; i < N - 10; i += 1) rs[i] = 80;
    for (let i = N - 10; i < N; i += 1) rs[i] = 66;
    const g = at({ rsRatings: rs });
    expect(g.peakRs60).toBe(80);
    expect(g.isFormerLeader).toBe(true);
  });

  it("峰值超窗口 60 日后失效", () => {
    const rs = flat(50);
    for (let i = 0; i < N - 100; i += 1) rs[i] = 90;
    for (let i = N - 100; i < N; i += 1) rs[i] = 66;
    const g = at({ rsRatings: rs });
    expect(g.peakRs60).toBe(66);
    expect(g.isFormerLeader).toBe(false);
  });

  it("年度涨幅达 1.35 倍且 RS >= 65 也算", () => {
    const closes = flat(100);
    for (let i = N - 252; i < N; i += 1) closes[i] = 140;
    const g = at({ closes, rsRatings: flat(66) });
    expect(g.perf252).toBeCloseTo(1.4, 6);
    expect(g.isFormerLeader).toBe(true);
  });

  it("RS 不足 65 时两条通路都不成立", () => {
    expect(at({ rsRatings: flat(64) }).isFormerLeader).toBe(false);
  });

  it("长期下行时强制为假", () => {
    const g = at({ closes: flat(90), rsRatings: flat(30), ema850: 100 });
    expect(g.isFormerLeader).toBe(false);
  });

  it("历史不足 252 根时年度涨幅记 1.0", () => {
    expect(at({ index: 100 }).perf252).toBe(1.0);
  });
});

describe("超级动能", () => {
  it("RS >= 80 时成立", () => {
    expect(at({ rsRatings: flat(85) }).isHyperMomentum).toBe(true);
  });

  it("RS >= 80 这一条是冗余的：peak_rs_60 >= rs，故必然先满足 is_former_leader", () => {
    const g = at({ rsRatings: flat(85) });
    expect(g.peakRs60).toBeGreaterThanOrEqual(85);
    expect(g.isFormerLeader).toBe(true);
  });

  it("RS 落在 65~74 且无其他条件时不成立", () => {
    expect(at({ rsRatings: flat(70) }).isHyperMomentum).toBe(false);
  });

  it("4H alpha >= 12 单独成立", () => {
    expect(at({ tfAlpha: 12 }).isHyperMomentum).toBe(true);
    expect(at({ tfAlpha: 11.9 }).isHyperMomentum).toBe(false);
  });

  it("4H alpha 缺失时该条件不成立，其余条件照常判定", () => {
    expect(at({ tfAlpha: null }).isHyperMomentum).toBe(false);
    expect(at({ tfAlpha: null, rsRatings: flat(85) }).isHyperMomentum).toBe(true);
  });

  it("站上 EMA200 的 1.30 倍单独成立", () => {
    expect(at({ closes: flat(130), ema200: 100 }).isHyperMomentum).toBe(true);
    expect(at({ closes: flat(129), ema200: 100 }).isHyperMomentum).toBe(false);
  });

  it("曾经的龙头单独成立", () => {
    const closes = flat(100);
    for (let i = N - 252; i < N; i += 1) closes[i] = 140;
    expect(at({ closes, rsRatings: flat(66), ema200: 200 }).isHyperMomentum).toBe(true);
  });

  it("长期下行时强制为假，四个条件全不看", () => {
    const g = at({ closes: flat(90), rsRatings: flat(30), ema850: 100, tfAlpha: 99 });
    expect(g.isHyperMomentum).toBe(false);
  });

  it("EMA200 未预热时按现价处理，比值恰为 1，该条件不成立", () => {
    expect(at({ ema200: null }).isHyperMomentum).toBe(false);
  });
});

describe("4H 相对 alpha", () => {
  const ramp = (pct: number, n = 100) =>
    Array.from({ length: n }, (_, i) => 100 * (1 + pct / 100) ** i);

  it("与基准同步时为 0", () => {
    const s = ramp(0.5);
    expect(fourHourAlpha(s, s)).toBeCloseTo(0, 10);
  });

  it("跑赢基准为正，跑输为负", () => {
    expect(fourHourAlpha(ramp(0.8), ramp(0.3))!).toBeGreaterThan(0);
    expect(fourHourAlpha(ramp(0.1), ramp(0.3))!).toBeLessThan(0);
  });

  it("按 0.6 / 0.4 加权两个回看窗口", () => {
    const bench = new Array(100).fill(100);
    const stock = new Array(100).fill(100);
    // 只在最近 20 根内抬升，则 20 根窗口与 50 根窗口涨幅相同
    stock[99] = 110;
    const alpha = fourHourAlpha(stock, bench)!;
    expect(alpha).toBeCloseTo(0.6 * 10 + 0.4 * 10, 6);
  });

  it("历史不足 51 根时返回 null", () => {
    expect(fourHourAlpha(new Array(50).fill(100), new Array(50).fill(100))).toBeNull();
    expect(fourHourAlpha(new Array(51).fill(100), new Array(51).fill(100))).toBe(0);
  });

  it("两序列长度不一致时抛错", () => {
    expect(() => fourHourAlpha(new Array(60).fill(1), new Array(59).fill(1))).toThrow(
      /长度不一致/,
    );
  });
});
