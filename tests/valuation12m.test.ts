import {
  MAX_PE_MID,
  type ValuationInput,
  computeValuation,
  macroMultiplier,
} from "@/lib/scoring/valuation12m";
import { describe, expect, it } from "vitest";

const base: ValuationInput = {
  close: 100,
  atr: 3,
  ema200: 90,
  trendScore: 5,
  rs: 50,
  stage: "B",
  isInLongDowntrend: false,
  isHyperMomentum: false,
  fsmState: 1,
  pathId: 0,
  epsTtm: 5,
  revTtm: 10e9,
  sharesOutstanding: 1e9,
  marketCap: 50e9,
  epsQYoY: 0.05,
  analystTarget: null,
  analystCount: 0,
};

const at = (over: Partial<ValuationInput>) => computeValuation({ ...base, ...over });

describe("宏观折价系数", () => {
  it("按 FSM 状态取值，未知状态记 1.0", () => {
    expect(macroMultiplier(0)).toBe(1.05);
    expect(macroMultiplier(1)).toBe(1.0);
    expect(macroMultiplier(2)).toBe(0.92);
    expect(macroMultiplier(3)).toBe(0.85);
    expect(macroMultiplier(9)).toBe(1.0);
  });

  it("目标价按该系数缩放", () => {
    const neutral = at({ fsmState: 1 }).primaryTarget;
    expect(at({ fsmState: 3 }).primaryTarget).toBeCloseTo(neutral * 0.85, 6);
    expect(at({ fsmState: 0 }).primaryTarget).toBeCloseTo(neutral * 1.05, 6);
  });
});

describe("长期下行分支", () => {
  it("大盘股走 EMA200 + 2×ATR 均值修复", () => {
    const v = at({ isInLongDowntrend: true, marketCap: 300e9, rs: 20, trendScore: 2 });
    expect(v.mode).toBe("leader_mean_reversion");
    expect(v.primaryTarget).toBeCloseTo(90 + 2 * 3, 6);
  });

  it("EMA200 缺失时退回现价作锚", () => {
    const v = at({
      isInLongDowntrend: true,
      marketCap: 300e9,
      ema200: null,
      rs: 20,
      trendScore: 2,
    });
    expect(v.primaryTarget).toBeCloseTo(100 + 2 * 3, 6);
  });

  it("中小盘股走 PE 22 保守模型", () => {
    const v = at({ isInLongDowntrend: true, marketCap: 50e9, rs: 20, trendScore: 2 });
    expect(v.mode).toBe("bear_conservative");
    expect(v.calculatedPe).toBe(22);
    expect(v.primaryTarget).toBeCloseTo(5 * 22, 6);
  });

  it("中小盘股无 EPS 时给现价 85 折", () => {
    const v = at({
      isInLongDowntrend: true,
      marketCap: 50e9,
      epsTtm: null,
      rs: 20,
      trendScore: 2,
    });
    expect(v.primaryTarget).toBeCloseTo(85, 6);
  });

  it("长期下行时不触发防倒挂，目标价可以低于现价", () => {
    const v = at({ isInLongDowntrend: true, marketCap: 50e9, epsTtm: 3, rs: 95, trendScore: 10 });
    expect(v.primaryTarget).toBeCloseTo(66, 6);
    expect(v.mode).toBe("bear_conservative");
  });
});

describe("PE 系分支", () => {
  it("高 PE 且有营收时走 PS 重估", () => {
    const v = at({ epsTtm: 2, rs: 60 });
    expect(v.currentPe).toBe(50);
    expect(v.mode).toBe("ps_revaluation");
  });

  it("PS 重估的结果与营收、股本无关，只是现价加成", () => {
    const a = at({ epsTtm: 2, rs: 60, revTtm: 10e9, sharesOutstanding: 1e9 });
    const b = at({ epsTtm: 2, rs: 60, revTtm: 777e9, sharesOutstanding: 13e9 });
    expect(a.primaryTarget).toBeCloseTo(b.primaryTarget, 9);
    expect(a.primaryTarget).toBeCloseTo(100 * 1.12, 6);
  });

  it("PS 重估在 RS >= 75 时用 1.20 而非 1.12", () => {
    expect(at({ epsTtm: 2, rs: 76 }).primaryTarget).toBeCloseTo(120, 6);
    expect(at({ epsTtm: 2, rs: 74 }).primaryTarget).toBeCloseTo(112, 6);
  });

  it("高 PE 但缺营收数据时走 PE × 1.18，封顶 75", () => {
    const v = at({ epsTtm: 2, revTtm: null, rs: 60 });
    expect(v.mode).toBe("high_pe_expansion");
    expect(v.calculatedPe).toBeCloseTo(50 * 1.18, 6);

    const capped = at({ epsTtm: 1, revTtm: null, rs: 60 });
    expect(capped.calculatedPe).toBe(75);
  });

  it("单季 EPS 同比超 15% 时走 PEG 模型", () => {
    const v = at({ epsQYoY: 0.3 });
    expect(v.mode).toBe("peg_growth");
    expect(v.calculatedPe).toBeCloseTo(30, 6);
  });

  it("PEG 的目标 PE 下限 18、上限 60", () => {
    expect(at({ epsQYoY: 0.16 }).calculatedPe).toBe(18);
    expect(at({ epsQYoY: 9.9 }).calculatedPe).toBe(Math.min(50, MAX_PE_MID));
  });

  it("超级动能按市值分档封顶 PE", () => {
    const small = at({ isHyperMomentum: true, epsTtm: 3, marketCap: 50e9 });
    expect(small.mode).toBe("momentum_expansion");
    expect(small.calculatedPe).toBeCloseTo(Math.min((100 / 3) * 1.2, 55), 6);

    const large = at({ isHyperMomentum: true, epsTtm: 3, marketCap: 300e9 });
    expect(large.calculatedPe).toBeCloseTo(Math.min((100 / 3) * 1.2, 42), 6);
  });

  it("其余情况按市值取基准 PE 30 / 35 / 25", () => {
    // 万亿档的 EPS 要压低到目标价不撞 +35% 上限，否则 mode 会被上限改写
    expect(at({ marketCap: 1500e9, epsTtm: 4 }).calculatedPe).toBe(30);
    expect(at({ marketCap: 300e9 }).calculatedPe).toBe(35);
    expect(at({ marketCap: 50e9 }).calculatedPe).toBe(25);
  });

  it("分支优先级：高 PE 早于 PEG，PEG 早于动能", () => {
    expect(at({ epsTtm: 2, epsQYoY: 0.9, isHyperMomentum: true }).mode).toBe("ps_revaluation");
    expect(at({ epsQYoY: 0.9, isHyperMomentum: true }).mode).toBe("peg_growth");
  });
});

describe("无 EPS 分支", () => {
  it("有营收时走动态 PS", () => {
    const v = at({ epsTtm: null, rs: 30, trendScore: 3 });
    expect(v.mode).toBe("dynamic_ps");
    expect(v.primaryTarget).toBeCloseTo(112, 6);
  });

  it("动态 PS 在超级动能下用 1.25", () => {
    const v = at({ epsTtm: null, isHyperMomentum: true, rs: 30, trendScore: 3 });
    expect(v.primaryTarget).toBeCloseTo(125, 6);
  });

  it("EPS 为负等同于无 EPS", () => {
    expect(at({ epsTtm: -2, rs: 30, trendScore: 3 }).mode).toBe("dynamic_ps");
  });

  it("既无 EPS 也无营收时退回技术兜底", () => {
    const v = at({
      epsTtm: null,
      revTtm: null,
      sharesOutstanding: null,
      rs: 30,
      trendScore: 3,
    });
    expect(v.mode).toBe("technical_fallback");
    expect(v.primaryTarget).toBeCloseTo(90 + 4 * 3, 6);
  });
});

describe("防倒挂", () => {
  // EPS 2.8 → PE 35.7，低于高 PE 门槛 40，走大盘基准 PE 35，目标 98 略低于现价
  const belowPrice = { epsTtm: 2.8, marketCap: 300e9, epsQYoY: 0 } as const;

  it("强势标的的目标价被顶到现价 × 1.22", () => {
    const v = at({ ...belowPrice, rs: 85 });
    expect(v.mode).toBe("anti_inversion");
    expect(v.primaryTarget).toBeCloseTo(122, 6);
  });

  it("趋势分 >= 7 也算强势", () => {
    expect(at({ ...belowPrice, trendScore: 7, rs: 30 }).mode).toBe("anti_inversion");
  });

  it("非强势标的不顶，目标价允许低于现价", () => {
    const v = at({ ...belowPrice, rs: 30, trendScore: 3 });
    expect(v.primaryTarget).toBeCloseTo(98, 6);
    expect(v.mode).toBe("steady_growth_pe");
  });

  it("目标价本就高于现价时不改写", () => {
    const v = at({ rs: 85, epsTtm: 5, marketCap: 300e9, epsQYoY: 0 });
    expect(v.mode).toBe("steady_growth_pe");
  });
});

describe("分析师共识平滑", () => {
  it("分歧超 25% 时取五五开", () => {
    const v = at({ analystTarget: 300, analystCount: 5, epsQYoY: 0 });
    expect(v.consensusSmoothed).toBe(true);
    const model = 5 * 25; // 中小盘基准 PE 25
    expect(v.primaryTarget).toBeCloseTo(0.5 * model + 0.5 * 300, 6);
  });

  it("分歧不足 25% 时不动", () => {
    const v = at({ analystTarget: 130, analystCount: 5, epsQYoY: 0 });
    expect(v.consensusSmoothed).toBe(false);
    expect(v.primaryTarget).toBeCloseTo(125, 6);
  });

  it("分析师家数不足 3 时不平滑", () => {
    expect(at({ analystTarget: 300, analystCount: 2, epsQYoY: 0 }).consensusSmoothed).toBe(false);
  });

  it("无分析师目标价时不平滑", () => {
    expect(at({ analystTarget: null, analystCount: 9, epsQYoY: 0 }).consensusSmoothed).toBe(false);
  });
});

describe("万亿体量上限与结构性兜底", () => {
  it("万亿市值且非超级动能时目标价压到现价 +35%", () => {
    // EPS 6 → PE 16.7 走万亿基准 PE 30，目标 180，被压回 135
    const v = at({ marketCap: 1500e9, epsTtm: 6, epsQYoY: 0 });
    expect(v.mode).toBe("trillion_cap");
    expect(v.primaryTarget).toBeCloseTo(135, 6);
  });

  it("超级动能的万亿标的不受该上限约束", () => {
    // 同一组基本面走 PEG（目标 300），有无超级动能决定压不压
    const capped = at({ marketCap: 1500e9, epsTtm: 6, epsQYoY: 0.5 });
    expect(capped.mode).toBe("trillion_cap");
    expect(capped.primaryTarget).toBeCloseTo(135, 6);

    const free = at({ marketCap: 1500e9, epsTtm: 6, epsQYoY: 0.5, isHyperMomentum: true });
    expect(free.mode).toBe("peg_growth");
    expect(free.primaryTarget).toBeCloseTo(300, 6);
  });

  it("目标价低于现价一半时兜底到 95%", () => {
    // EPS 2.6 + 同比 16% → PEG 取下限 18，目标 46.8，不足现价一半
    const v = at({ epsTtm: 2.6, epsQYoY: 0.16, marketCap: 50e9, rs: 30, trendScore: 3 });
    expect(v.mode).toBe("structural_floor");
    expect(v.primaryTarget).toBeCloseTo(95, 6);
  });
});

describe("标的基因", () => {
  it("无 EPS 且弱势判为纯技术博弈", () => {
    expect(at({ epsTtm: null, trendScore: 3, rs: 60 }).archetype).toBe("tech_only");
    expect(at({ epsTtm: null, trendScore: 8, rs: 40 }).archetype).toBe("tech_only");
  });

  it("无 EPS 但强势判为高弹性成长", () => {
    expect(at({ epsTtm: null, trendScore: 8, rs: 60 }).archetype).toBe("high_beta_growth");
  });

  it("PE >= 45 判为成长动能溢价", () => {
    expect(at({ epsTtm: 2 }).archetype).toBe("growth_premium");
  });

  it("PE < 45 且处于 Stage C 判为高位派发", () => {
    expect(at({ stage: "C" }).archetype).toBe("distribution");
  });

  it("高 PE 优先于 Stage C", () => {
    expect(at({ epsTtm: 2, stage: "C" }).archetype).toBe("growth_premium");
  });

  it("其余判为价值/趋势配置", () => {
    expect(at({}).archetype).toBe("value_trend");
  });
});

describe("低吸仲裁标志", () => {
  it("上行空间 >= 15% 且宏观未破位时开启", () => {
    const v = at({ epsTtm: 2, rs: 76 });
    expect(v.upsidePct).toBeCloseTo(20, 6);
    expect(v.isDipActive).toBe(true);
  });

  it("Path 4 下强制关闭", () => {
    expect(at({ epsTtm: 2, rs: 76, pathId: 4 }).isDipActive).toBe(false);
  });

  it("上行空间不足 15% 时关闭", () => {
    const v = at({ epsTtm: 2, rs: 60 });
    expect(v.upsidePct).toBeCloseTo(12, 6);
    expect(v.isDipActive).toBe(false);
  });
});

describe("不变量", () => {
  it("目标价恒为正", () => {
    for (const eps of [null, -5, 0.01, 5, 100]) {
      for (const mcap of [null, 1e9, 300e9, 3000e9]) {
        for (const down of [true, false]) {
          const v = at({ epsTtm: eps, marketCap: mcap, isInLongDowntrend: down });
          expect(v.primaryTarget).toBeGreaterThan(0);
          expect(Number.isFinite(v.primaryTarget)).toBe(true);
        }
      }
    }
  });

  it("上行空间与目标价、现价自洽", () => {
    const v = at({ epsTtm: 2, rs: 76 });
    expect(v.upsidePct).toBeCloseTo(((v.primaryTarget - 100) / 100) * 100, 9);
  });
});
