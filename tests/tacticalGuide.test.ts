import type { StockStage } from "@/lib/scoring/stockStage";
import { type TacticalInput, computeTacticalGuide } from "@/lib/scoring/tacticalGuide";
import { describe, expect, it } from "vitest";

const STAGES: StockStage[] = ["A", "B", "C", "D", "E", "W"];
const PATHS = [0, 1, 2, 3, 4];

const base: TacticalInput = {
  holding: false,
  buy1: false,
  buy2: false,
  rsiOk: true,
  pathId: 0,
  stage: "B",
};

const at = (over: Partial<TacticalInput>) => computeTacticalGuide({ ...base, ...over });

describe("第 1 层：持仓优先", () => {
  it("有持仓时形态阶段完全不影响判定", () => {
    for (const pathId of PATHS) {
      const verdicts = STAGES.map((stage) => at({ holding: true, pathId, stage }));
      const first = JSON.stringify(verdicts[0]);
      for (const v of verdicts) expect(JSON.stringify(v)).toBe(first);
    }
  });

  it("有持仓时点火信号也不改变判定", () => {
    const withSignal = at({ holding: true, buy1: true });
    const without = at({ holding: true });
    expect(withSignal).toEqual(without);
  });

  it("Path 0 顺风时依托移动止盈放大利润", () => {
    expect(at({ holding: true, pathId: 0 })).toEqual({
      action: "hold_ride",
      tone: "favorable",
      layer: "holding",
    });
  });

  it("Path 2 / 4 一律降险", () => {
    for (const pathId of [2, 4]) {
      expect(at({ holding: true, pathId })).toMatchObject({
        action: "hold_derisk",
        tone: "danger",
      });
    }
  });

  it("Path 1 与 Path 3 都是收紧防守，但 Path 1 更紧张", () => {
    expect(at({ holding: true, pathId: 1 })).toMatchObject({
      action: "hold_defend",
      tone: "caution",
    });
    expect(at({ holding: true, pathId: 3 })).toMatchObject({
      action: "hold_defend",
      tone: "neutral",
    });
  });

  it("所有持仓判定都标记为 holding 层", () => {
    for (const pathId of PATHS) {
      expect(at({ holding: true, pathId }).layer).toBe("holding");
    }
  });
});

describe("第 2 层：空仓遇点火", () => {
  it("宏观健康时放行标准建仓", () => {
    for (const pathId of [0, 3]) {
      expect(at({ buy1: true, pathId })).toMatchObject({
        action: "enter_standard",
        layer: "signal",
      });
    }
  });

  it("Path 1 逆风时降为轻仓试错", () => {
    expect(at({ buy1: true, pathId: 1 })).toMatchObject({
      action: "enter_light",
      tone: "caution",
    });
  });

  it("Path 2 / 4 高危时冻结，不接飞刀", () => {
    for (const pathId of [2, 4]) {
      expect(at({ buy1: true, pathId })).toMatchObject({
        action: "enter_frozen",
        tone: "danger",
      });
    }
  });

  it("一买与二买走同一条仲裁路径", () => {
    for (const pathId of PATHS) {
      expect(at({ buy1: true, pathId })).toEqual(at({ buy2: true, pathId }));
    }
  });

  it("RSI 闸门未放行时点火不进第 2 层，落到形态层", () => {
    const blocked = at({ buy1: true, rsiOk: false, stage: "A" });
    expect(blocked.layer).toBe("regime");
    expect(blocked.action).toBe("breakout_follow");
  });
});

describe("第 3 层：空仓无信号", () => {
  it("Path 2 / 4 强制防御，形态再好也不介入", () => {
    for (const pathId of [2, 4]) {
      for (const stage of STAGES) {
        expect(at({ pathId, stage })).toMatchObject({
          action: "wait_defensive",
          tone: "danger",
        });
      }
    }
  });

  it("Path 1 下突破带只许回踩低吸，不许追高", () => {
    expect(at({ pathId: 1, stage: "A" })).toMatchObject({
      action: "wait_dip",
      tone: "caution",
    });
  });

  it("Path 1 下高位延伸与破位都判为禁止介入", () => {
    for (const stage of ["C", "D"] as const) {
      expect(at({ pathId: 1, stage })).toMatchObject({ action: "wait_avoid", tone: "danger" });
    }
  });

  it("宏观健康时突破带才给顺势追买", () => {
    expect(at({ pathId: 0, stage: "A" })).toMatchObject({
      action: "breakout_follow",
      tone: "favorable",
    });
    // 同一形态在 Path 1 下降级
    expect(at({ pathId: 1, stage: "A" }).action).toBe("wait_dip");
  });

  it("震荡箱体给区间套利，混沌筑底给左侧分批", () => {
    expect(at({ pathId: 0, stage: "W" }).action).toBe("range_trade");
    expect(at({ pathId: 0, stage: "E" }).action).toBe("accumulate");
  });

  it("箱体蓄势给低吸布局", () => {
    expect(at({ pathId: 0, stage: "B" }).action).toBe("wait_dip");
  });

  it("高位延伸与趋势衰减一律禁止介入", () => {
    for (const stage of ["C", "D"] as const) {
      expect(at({ pathId: 0, stage }).action).toBe("wait_avoid");
    }
  });
});

describe("全组合不变量", () => {
  it("任意输入组合都有判定，不会落空", () => {
    for (const holding of [true, false]) {
      for (const buy1 of [true, false]) {
        for (const rsiOk of [true, false]) {
          for (const pathId of PATHS) {
            for (const stage of STAGES) {
              const v = computeTacticalGuide({ holding, buy1, buy2: false, rsiOk, pathId, stage });
              expect(v.action).toBeTruthy();
              expect(["danger", "caution", "neutral", "favorable"]).toContain(v.tone);
            }
          }
        }
      }
    }
  });

  it("Path 4 在任何一层都不会给出乐观判定", () => {
    for (const holding of [true, false]) {
      for (const buy1 of [true, false]) {
        for (const stage of STAGES) {
          const v = computeTacticalGuide({
            holding,
            buy1,
            buy2: false,
            rsiOk: true,
            pathId: 4,
            stage,
          });
          expect(v.tone).toBe("danger");
        }
      }
    }
  });
});
