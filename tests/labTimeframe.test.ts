import { describe, expect, it } from "vitest";

import { barsPerYearOf } from "@/lib/backtest/engine";
import { parseConfig, parseTimeframe } from "@/lib/backtest/labRequest";
import { SMALL_FUND_4H_FROM } from "@/lib/backtest/smallFundUniverse";

describe("lab timeframe", () => {
  it("未传默认日线", () => {
    expect(parseTimeframe({})).toBe("1d");
    const c = parseConfig({ index: "SMALLFUND" });
    expect(c.timeframe).toBe("1d");
    expect(c.requireVegas).toBe(true);
    expect(c.requireRsi).toBe(true);
    expect(c.takeProfitR).toBeNull();
  });

  it("Small Fund 4H 未传旋钮用当前纪律，传入则覆盖", () => {
    const frozen = parseConfig({ index: "SMALLFUND", timeframe: "4h" });
    expect(frozen.timeframe).toBe("4h");
    expect(frozen.from).toBe(SMALL_FUND_4H_FROM);
    expect(frozen.rpsMin).toBe(0);
    expect(frozen.stopMult).toBe(8);
    expect(frozen.trailMult).toBe(10);
    expect(frozen.takeProfitR).toBeNull();
    expect(frozen.requireVegas).toBe(true);
    expect(frozen.requireRsi).toBe(true);

    const tuned = parseConfig({
      index: "SMALLFUND",
      timeframe: "4h",
      rpsMin: 90,
      takeProfitR: 3,
    });
    expect(tuned.rpsMin).toBe(90);
    expect(tuned.takeProfitR).toBe(3);
    expect(tuned.stopMult).toBe(8);
    // 常规时段 6.5 小时实测每天 2 / 3 / 6 根，不是 2 / 4 / 8。
    // 2H 原按 252×4 算，把年化高估了三分之一
    expect(barsPerYearOf("4h")).toBe(504);
    expect(barsPerYearOf("2h")).toBe(756);
    expect(barsPerYearOf("1h")).toBe(1512);
  });

  it("非 Small Fund 不能开 4H", () => {
    expect(() => parseConfig({ index: "SP500", timeframe: "4h" })).toThrow(/Small Fund/);
  });
});
