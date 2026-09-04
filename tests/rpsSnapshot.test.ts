import { describe, expect, it } from "vitest";

import { pickRps, resolveAlertTimeframe, type RpsSnapshot } from "@/lib/backtest/rpsSnapshot";

const snapshot: RpsSnapshot = {
  generatedAt: "2026-08-31T09:00:00.000Z",
  poolId: "sf-2026-08",
  timeframes: {
    "1d": { AAPL: { rps: 52.59, asOf: "2026-08-21" } },
  },
};

describe("rps 快照查值", () => {
  it("命中时带上面板日期", () => {
    expect(pickRps(snapshot, "AAPL", "1d")).toEqual({ rps: 52.59, asOf: "2026-08-21" });
  });

  it("不在池里返回 null，闸门该标 unknown 而不是报错", () => {
    expect(pickRps(snapshot, "ZZZZ", "1d")).toBeNull();
  });

  it("快照缺失或缺档要抛错，不能静默当作不在池里", () => {
    expect(() => pickRps(null, "AAPL", "1d")).toThrow(/rps:snapshot/i);
    expect(() => pickRps(snapshot, "AAPL", "4h")).toThrow(/4h/);
  });

  it("TV 周期别名都落到可查的档", () => {
    expect(resolveAlertTimeframe("120")).toBe("2h");
    expect(resolveAlertTimeframe("2H")).toBe("2h");
    expect(resolveAlertTimeframe("240")).toBe("4h");
    expect(resolveAlertTimeframe("4h")).toBe("4h");
    expect(resolveAlertTimeframe("60")).toBe("1h");
    expect(resolveAlertTimeframe("D")).toBe("1d");
    expect(resolveAlertTimeframe("W")).toBe("1d");
  });
});
