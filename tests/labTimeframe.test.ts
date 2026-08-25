import { describe, expect, it } from "vitest";

import { barsPerYearOf } from "@/lib/backtest/engine";
import { parseConfig, parseTimeframe } from "@/lib/backtest/labRequest";
import { SMALL_FUND_4H_FROM } from "@/lib/backtest/smallFundUniverse";

describe("lab timeframe", () => {
  it("未传默认日线", () => {
    expect(parseTimeframe({})).toBe("1d");
    expect(parseConfig({ index: "SMALLFUND" }).timeframe).toBe("1d");
  });

  it("Small Fund 4H 用自己的平台默认", () => {
    const c = parseConfig({ index: "SMALLFUND", timeframe: "4h" });
    expect(c.timeframe).toBe("4h");
    expect(c.from).toBe(SMALL_FUND_4H_FROM);
    expect(c.rpsMin).toBe(50);
    expect(c.stopMult).toBe(6);
    expect(c.trailMult).toBe(6);
    expect(c.takeProfitR).toBeNull();
    expect(barsPerYearOf("4h")).toBe(504);
    expect(barsPerYearOf("2h")).toBe(1008);
  });

  it("非 Small Fund 不能开 4H", () => {
    expect(() => parseConfig({ index: "SP500", timeframe: "4h" })).toThrow(/Small Fund/);
  });
});
