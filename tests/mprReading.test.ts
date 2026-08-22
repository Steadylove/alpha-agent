import type { MacroPhaseSnapshot } from "@/lib/dashboard/mpr";
import { macroPhaseReading } from "@/lib/scoring/mprReading";
import { describe, expect, it } from "vitest";

const snapshot = (over: Partial<MacroPhaseSnapshot> = {}): MacroPhaseSnapshot => ({
  date: "2026-08-20",
  pathId: 0,
  fsmState: 0,
  marketRiskScore: 10,
  prob5dDown: 20,
  f1: 20,
  f2: 20,
  f3: 20,
  f4: 20,
  f5: 20,
  rawTerm: 0.8,
  rawCred: 1.4,
  domVol: 20,
  domCred: 20,
  domSpot: 20,
  spyDamage: 10,
  leadGap: 0,
  leadPersist: 0,
  leadQuality: 0,
  transVel: 0,
  transDepth: 0,
  couplingRatio: 0,
  sigmaVol: 0,
  sigmaCred: 0,
  sigmaSpot: 0,
  ...over,
});

describe("macroPhaseReading", () => {
  it("三域全静的 Path 0 判为真稳态", () => {
    const r = macroPhaseReading(snapshot({ pathId: 0, domVol: 20, domCred: 30, domSpot: 40 }));
    expect(r.isPathZeroFallthrough).toBe(false);
    expect(r.tone).toBe("positive");
  });

  it("有域承压的 Path 0 判为兜底落入，且不得为 positive", () => {
    const r = macroPhaseReading(snapshot({ pathId: 0, domCred: 80, domSpot: 90, spyDamage: 60 }));
    expect(r.isPathZeroFallthrough).toBe(true);
    expect(r.tone).not.toBe("positive");
    expect(r.headline).toContain("承压");
  });

  it("Path 0 兜底判定只看三域，与 pathId 之外的字段无关", () => {
    // 任一域达到 50 即算异动
    expect(macroPhaseReading(snapshot({ domVol: 50 })).isPathZeroFallthrough).toBe(true);
    expect(macroPhaseReading(snapshot({ domCred: 50 })).isPathZeroFallthrough).toBe(true);
    expect(macroPhaseReading(snapshot({ domSpot: 50 })).isPathZeroFallthrough).toBe(true);
    expect(macroPhaseReading(snapshot({ domVol: 49.9 })).isPathZeroFallthrough).toBe(false);
  });

  it("非 Path 0 一律不标记兜底", () => {
    for (const pathId of [1, 2, 3, 4]) {
      expect(macroPhaseReading(snapshot({ pathId, domCred: 90 })).isPathZeroFallthrough).toBe(false);
    }
  });

  it("Path 4 判为高波动区制而非看跌", () => {
    const r = macroPhaseReading(snapshot({ pathId: 4, fsmState: 3, spyDamage: 85 }));
    expect(r.tone).toBe("danger");
    expect(r.headline).toContain("高波动");
    expect(r.headline).not.toContain("看跌");
  });

  it("每条路径都有判读，不会出现空文案", () => {
    for (const pathId of [0, 1, 2, 3, 4]) {
      const r = macroPhaseReading(snapshot({ pathId }));
      expect(r.pathLabel.length).toBeGreaterThan(0);
      expect(r.headline.length).toBeGreaterThan(0);
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });

  it("不输出任何方向性的仓位建议", () => {
    for (const pathId of [0, 1, 2, 3, 4]) {
      const r = macroPhaseReading(snapshot({ pathId }));
      const text = `${r.headline}${r.detail}`;
      expect(text).not.toMatch(/敞口|满仓|加仓|清仓|买入|卖出/);
    }
  });
});
