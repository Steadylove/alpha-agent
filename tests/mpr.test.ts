import {
  MPR_DEFAULTS,
  MPR_SYMBOLS,
  alignMprInputs,
  computeMprSeries,
  rollingEcdf,
  type AlignBar,
  type MprInput,
  type MprSymbol,
} from "@/lib/scoring/mpr";
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

/** 前段常态、后段全域崩塌的行情，用于触发高 Path。 */
function makeCrashInput(days: number, crashFrom: number, seed = 42): MprInput[] {
  const r = lcg(seed);
  let spy = 100;
  let rsp = 100;
  let tlt = 100;
  let dxy = 100;
  let hyg = 100;
  let iei = 100;

  return Array.from({ length: days }, (_, i) => {
    const crashing = i >= crashFrom;
    spy *= 1 + (crashing ? -0.015 : (r() - 0.45) * 0.01);
    rsp *= 1 + (crashing ? -0.018 : (r() - 0.45) * 0.01);
    tlt *= 1 + (crashing ? 0.004 : (r() - 0.5) * 0.008);
    dxy *= 1 + (crashing ? 0.002 : (r() - 0.5) * 0.004);
    hyg *= 1 + (crashing ? -0.008 : (r() - 0.48) * 0.005);
    iei *= 1 + (r() - 0.5) * 0.002;
    const vix = crashing ? 28 + r() * 15 : 13 + r() * 4;

    return {
      date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      spyClose: spy,
      spyVolume: (crashing ? 160 : 70) * 1e6 + r() * 2e7,
      rspClose: rsp,
      tltClose: tlt,
      dxyClose: dxy,
      hygClose: hyg,
      ieiClose: iei,
      vixClose: vix,
      vix9dClose: vix * (crashing ? 1.15 : 0.85 + r() * 0.1),
      vix3mClose: vix * (crashing ? 0.95 : 1.1 + r() * 0.1),
    };
  });
}

describe("传导路径判定", () => {
  it("全域崩塌行情最终进入 Path 4 破位确认", () => {
    const last = computeMprSeries(makeCrashInput(400, 330)).at(-1)!;
    expect(last.pathId).toBe(4);
    expect(last.fsmState).toBe(3);
    expect(last.transDepth).toBe(3);
  });

  it("Path 与 transDepth 一一对应", () => {
    const depthByPath: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 1, 4: 3 };
    for (const day of computeMprSeries(makeCrashInput(400, 330))) {
      expect(day.transDepth).toBe(depthByPath[day.pathId]);
    }
  });

  it("Path 与 fsmState 一一对应", () => {
    const stateByPath: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 1, 4: 3 };
    for (const day of computeMprSeries(makeCrashInput(400, 330))) {
      expect(day.fsmState).toBe(stateByPath[day.pathId]);
    }
  });

  it("各 Path 的定义条件在全序列成立", () => {
    for (const day of [
      ...computeMprSeries(makeCrashInput(400, 330)),
      ...computeMprSeries(makeMarketInput(600)),
    ]) {
      // Path 2 的定义含 spyDamage < 60，破坏度过高时必须让位给 Path 4
      if (day.pathId === 2) {
        expect(day.spyDamage).toBeLessThan(60);
        expect(day.sigmaSpot).toBeGreaterThanOrEqual(1);
        expect(Math.max(day.sigmaVol, day.sigmaCred)).toBeGreaterThanOrEqual(1);
      }
      // Path 1 要求现货域完全平静
      if (day.pathId === 1) {
        expect(day.sigmaSpot).toBe(0);
        expect(Math.max(day.sigmaVol, day.sigmaCred)).toBeGreaterThanOrEqual(1);
      }
      // Path 3 要求衍生品域与信用域都平静
      if (day.pathId === 3) {
        expect(day.sigmaVol).toBe(0);
        expect(day.sigmaCred).toBe(0);
        expect(day.sigmaSpot).toBeGreaterThanOrEqual(1);
      }
      // Path 4 要求破坏度达标
      if (day.pathId === 4) {
        expect(day.spyDamage).toBeGreaterThanOrEqual(70);
      }
    }
  });

  /**
   * 原版 Pine 判定树的已知缺陷，这里用测试钉住，避免以后被误当成 bug「修掉」而破坏对拍。
   *
   * Path 0 是 else 兜底分支，不是「三域全静」。当 spyDamage 落在 [60, 70) 且三域有压力时：
   *   - Path 4 不匹配（damage < 70 或未跌破 EMA50）
   *   - Path 2 不匹配（要求 damage < 60）
   *   - Path 1 不匹配（要求 sigmaSpot == 0）
   *   - Path 3 不匹配（要求 vol 与 cred 均为 0）
   * 于是掉进 else，被标记为「稳态自洽 · 建议敞口 80~100%」。
   *
   * 语义上这是错的：两个域顶格 + 大盘已回撤，不该建议满仓。
   * 是否修正属于 Phase 2 的决策，Phase 1 只做忠实移植。
   */
  it("已知缺陷：Path 0 是兜底分支，可能在三域承压时被触发", () => {
    const fallthrough = computeMprSeries(makeMarketInput(900, 7))
      .slice(252)
      .filter(
        (d) =>
          d.pathId === 0 && (d.sigmaVol > 0 || d.sigmaCred > 0 || d.sigmaSpot > 0),
      );

    // 这些样本存在本身就是缺陷的证据；若某天此断言失败，说明判定树被改动过
    expect(fallthrough.length).toBeGreaterThan(0);
    for (const day of fallthrough) {
      expect(day.spyDamage).toBeGreaterThanOrEqual(60);
    }
  });

  it("sigma 分级与三域压力值一致", () => {
    for (const day of computeMprSeries(makeMarketInput(600))) {
      const expectSigma = (stress: number, sigma: number) => {
        if (stress >= 75) expect(sigma).toBe(2);
        else if (stress >= 50) expect(sigma).toBe(1);
        else expect(sigma).toBe(0);
      };
      expectSigma(day.domVol, day.sigmaVol);
      expectSigma(day.domCred, day.sigmaCred);
      expectSigma(day.domSpot, day.sigmaSpot);
    }
  });
});

describe("leadPersist 跨日状态递推", () => {
  it("每日只能是前值 +1 或归零", () => {
    for (const series of [computeMprSeries(makeCrashInput(400, 330)), computeMprSeries(makeMarketInput(600))]) {
      for (let i = 1; i < series.length; i += 1) {
        const cur = series[i].leadPersist;
        const prev = series[i - 1].leadPersist;
        expect(cur === prev + 1 || cur === 0).toBe(true);
      }
    }
  });

  it("递推条件成立时计数，不成立时清零", () => {
    const series = computeMprSeries(makeMarketInput(600));
    for (let i = 1; i < series.length; i += 1) {
      const day = series[i];
      const shouldCount = day.leadGap > 20 && day.spyDamage < 40;
      if (shouldCount) {
        expect(day.leadPersist).toBe(series[i - 1].leadPersist + 1);
      } else {
        expect(day.leadPersist).toBe(0);
      }
    }
  });

  it("leadPersist 为 0 时 leadQuality 必为 0（衰减因子归零）", () => {
    for (const day of computeMprSeries(makeMarketInput(600))) {
      if (day.leadPersist === 0) expect(day.leadQuality).toBe(0);
    }
  });

  it("leadQuality 与 couplingRatio 恒非负", () => {
    for (const day of computeMprSeries(makeCrashInput(400, 330))) {
      expect(day.leadQuality).toBeGreaterThanOrEqual(0);
      expect(day.couplingRatio).toBeGreaterThanOrEqual(0);
    }
  });

  it("序列有状态：截断起点会改变 leadPersist（不可只喂最近 N 根）", () => {
    const rows = makeMarketInput(600);
    const full = computeMprSeries(rows);
    const truncated = computeMprSeries(rows.slice(300));
    const fullLast = full.at(-1)!;
    const truncLast = truncated.at(-1)!;
    expect(fullLast.date).toBe(truncLast.date);
    // 至少有一个跨日状态量因起点不同而不同，说明确实是路径依赖的
    const anyDiff = full
      .slice(300)
      .some((day, i) => day.leadPersist !== truncated[i].leadPersist || day.f1 !== truncated[i].f1);
    expect(anyDiff).toBe(true);
  });
});

describe("alignMprInputs", () => {
  const bars = (dates: string[], close: number): AlignBar[] =>
    dates.map((date) => ({ date, close, volume: 1_000 }));

  /** 给全部 9 个标的同一组日期，再按需覆盖个别标的。 */
  const build = (
    dates: string[],
    overrides: Partial<Record<MprSymbol, AlignBar[]>> = {},
  ): Record<MprSymbol, AlignBar[]> => {
    const base = {} as Record<MprSymbol, AlignBar[]>;
    for (const symbol of MPR_SYMBOLS) base[symbol] = bars(dates, 100);
    return { ...base, ...overrides };
  };

  it("只保留所有标的都有数据的交易日", () => {
    const rows = alignMprInputs(
      build(["2020-01-01", "2020-01-02", "2020-01-03"], {
        RSP: bars(["2020-01-01", "2020-01-03"], 50),
      }),
    );
    expect(rows.map((r) => r.date)).toEqual(["2020-01-01", "2020-01-03"]);
  });

  it("输出按日期升序，与输入顺序无关", () => {
    const rows = alignMprInputs(build(["2020-01-03", "2020-01-01", "2020-01-02"]));
    expect(rows.map((r) => r.date)).toEqual(["2020-01-01", "2020-01-02", "2020-01-03"]);
  });

  it("各标的的收盘价被映射到正确字段", () => {
    const rows = alignMprInputs(
      build(["2020-01-01"], {
        SPY: [{ date: "2020-01-01", close: 300, volume: 90_000_000 }],
        RSP: bars(["2020-01-01"], 140),
        TLT: bars(["2020-01-01"], 160),
        DXY: bars(["2020-01-01"], 96),
        HYG: bars(["2020-01-01"], 87),
        IEI: bars(["2020-01-01"], 122),
        VIX: bars(["2020-01-01"], 18),
        VIX9D: bars(["2020-01-01"], 16),
        VIX3M: bars(["2020-01-01"], 21),
      }),
    );

    expect(rows[0]).toEqual({
      date: "2020-01-01",
      spyClose: 300,
      spyVolume: 90_000_000,
      rspClose: 140,
      tltClose: 160,
      dxyClose: 96,
      hygClose: 87,
      ieiClose: 122,
      vixClose: 18,
      vix9dClose: 16,
      vix3mClose: 21,
    });
  });

  it("DXY 多出的非美股交易日被丢弃（ICE 与 NYSE 日历不同）", () => {
    const rows = alignMprInputs(
      build(["2020-01-01", "2020-01-02"], {
        DXY: bars(["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"], 96),
      }),
    );
    expect(rows.map((r) => r.date)).toEqual(["2020-01-01", "2020-01-02"]);
  });

  it("任一标的缺失时返回空数组，不抛异常", () => {
    const input = build(["2020-01-01"]);
    input.VIX9D = [];
    expect(alignMprInputs(input)).toEqual([]);
  });
});
