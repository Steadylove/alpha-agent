import { assertFourHourShape } from "@/lib/backtest/intradayShape";
import { describe, expect, it } from "vitest";

describe("assertFourHourShape", () => {
  it("真 4H（每天 13:30 / 17:30）放过", () => {
    expect(() =>
      assertFourHourShape([
        {
          ticker: "WDC",
          dates: ["2026-08-26T13:30", "2026-08-26T17:30", "2026-09-08T13:30", "2026-09-08T17:30"],
        },
      ]),
    ).not.toThrow();
  });

  it("冬令 4H（14:30 / 18:30 UTC）放过", () => {
    expect(() =>
      assertFourHourShape([{ ticker: "AAPL", dates: ["2026-01-15T14:30", "2026-01-15T18:30"] }]),
    ).not.toThrow();
  });

  it("混进 2H 午盘 15:30 炸掉", () => {
    expect(() =>
      assertFourHourShape([
        {
          ticker: "AVGO",
          dates: ["2026-09-08T13:30", "2026-09-08T15:30", "2026-09-08T17:30"],
        },
      ]),
    ).toThrow(/AVGO 2026-09-08T15:30/);
  });

  it("冬令 2H 午盘 16:30 炸掉", () => {
    expect(() =>
      assertFourHourShape([{ ticker: "AVGO", dates: ["2026-01-15T14:30", "2026-01-15T16:30"] }]),
    ).toThrow(/16:30/);
  });

  it("单日三根即使没有 15:30 也炸", () => {
    expect(() =>
      assertFourHourShape([
        { ticker: "WDC", dates: ["2026-08-26T13:30", "2026-08-26T14:30", "2026-08-26T17:30"] },
      ]),
    ).toThrow(/WDC 2026-08-26/);
  });
});
