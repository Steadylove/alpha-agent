import { PATH_EXPOSURE, macroExposurePct } from "@/lib/scoring/macroExposure";
import { describe, expect, it } from "vitest";

describe("PATH_EXPOSURE", () => {
  it("五档区间与 MPR Pine 第 197~219 行一致", () => {
    expect(PATH_EXPOSURE[0]).toMatchObject({ minPct: 80, maxPct: 100 });
    expect(PATH_EXPOSURE[1]).toMatchObject({ minPct: 60, maxPct: 80 });
    expect(PATH_EXPOSURE[2]).toMatchObject({ minPct: 30, maxPct: 50 });
    expect(PATH_EXPOSURE[3]).toMatchObject({ minPct: 60, maxPct: 80 });
    expect(PATH_EXPOSURE[4]).toMatchObject({ minPct: 0, maxPct: 20 });
  });

  it("每档下界都不高于上界", () => {
    for (const band of Object.values(PATH_EXPOSURE)) {
      expect(band.minPct).toBeLessThanOrEqual(band.maxPct);
    }
  });
});

describe("macroExposurePct", () => {
  it("取区间中点", () => {
    expect(macroExposurePct(0)).toBe(90);
    expect(macroExposurePct(1)).toBe(70);
    expect(macroExposurePct(2)).toBe(40);
    expect(macroExposurePct(3)).toBe(70);
    expect(macroExposurePct(4)).toBe(10);
  });

  it("未知路径退回最保守的 Path 4 档位", () => {
    expect(macroExposurePct(99)).toBe(10);
    expect(macroExposurePct(-1)).toBe(10);
  });

  it("恒在 0~100 之间", () => {
    for (const pathId of [0, 1, 2, 3, 4, 99]) {
      const v = macroExposurePct(pathId);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});
