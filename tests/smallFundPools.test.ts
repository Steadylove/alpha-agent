import { describe, expect, it } from "vitest";

import type { MembershipSpan } from "@/lib/backtest/engine";
import { parseConfig, parsePoolId } from "@/lib/backtest/labRequest";
import {
  DEFAULT_SMALL_FUND_POOL,
  SMALL_FUND_ADDED_2026_08,
  membershipForPool,
  parseSmallFundPoolId,
  tickersForPool,
  SMALL_FUND_V1_COUNT,
  SMALL_FUND_V1_TICKERS,
} from "@/lib/backtest/smallFundPools";
import { SMALL_FUND_UNIVERSE } from "@/lib/backtest/smallFundUniverse";

function inSpan(date: string, spans: readonly MembershipSpan[]): boolean {
  return spans.some((s) => date >= s.start && (s.end == null || date <= s.end));
}

describe("small fund pools", () => {
  it("原池 97、扩池 100、合计 197", () => {
    expect(SMALL_FUND_V1_TICKERS).toHaveLength(SMALL_FUND_V1_COUNT);
    expect(SMALL_FUND_ADDED_2026_08).toHaveLength(100);
    expect(SMALL_FUND_UNIVERSE).toHaveLength(197);
    expect(SMALL_FUND_V1_TICKERS.at(-1)).toBe("ALAB");
    expect(SMALL_FUND_ADDED_2026_08[0]).toBe("ARM");
  });

  it("解析未知 poolId 回落到当前扩池", () => {
    expect(parseSmallFundPoolId("nope")).toBe(DEFAULT_SMALL_FUND_POOL);
    expect(parsePoolId({ index: "SMALLFUND" })).toBe("sf-2026-08");
    expect(parsePoolId({ index: "SMALLFUND", poolId: "sf-live" })).toBe("sf-live");
    expect(parsePoolId({ index: "SP500", poolId: "sf-v1" })).toBe(DEFAULT_SMALL_FUND_POOL);
  });

  it("V1 只有原池，扩池名单全程都在，活账本按生效日", () => {
    const tickers = ["NVDA", "ARM", "ALAB"];
    const v1 = membershipForPool("sf-v1", tickers);
    const full = membershipForPool("sf-2026-08", tickers);
    const live = membershipForPool("sf-live", tickers);

    expect(inSpan("2022-01-03", v1.get("NVDA")!)).toBe(true);
    expect(inSpan("2022-01-03", v1.get("ARM")!)).toBe(false);
    expect(inSpan("2022-01-03", full.get("ARM")!)).toBe(true);

    expect(inSpan("2026-07-31", live.get("ARM")!)).toBe(false);
    expect(inSpan("2026-08-01", live.get("ARM")!)).toBe(true);
    expect(inSpan("2026-08-01T09:30", live.get("ARM")!)).toBe(true);
    expect(inSpan("2022-01-03", live.get("NVDA")!)).toBe(true);
    expect(inSpan("2022-01-03", live.get("ALAB")!)).toBe(true);
  });

  it("V1 只载入原名单", () => {
    expect(tickersForPool("sf-v1")).toEqual(SMALL_FUND_V1_TICKERS);
    expect(tickersForPool("sf-live")).toEqual(SMALL_FUND_UNIVERSE);
    expect(tickersForPool("sf-2026-08")).toBe(SMALL_FUND_UNIVERSE);
  });

  it("Small Fund 未传旋钮用当前纪律，传入则覆盖", () => {
    const frozen = parseConfig({ index: "SMALLFUND" });
    expect(frozen.rpsMin).toBe(40);
    expect(frozen.stopMult).toBe(4);
    expect(frozen.requireVegas).toBe(true);
    expect(frozen.takeProfitR).toBeNull();

    const tuned = parseConfig({
      index: "SMALLFUND",
      rpsMin: 90,
      stopMult: 1,
      useBuy1: false,
      requireVegas: false,
      takeProfitR: 1,
    });
    expect(tuned.rpsMin).toBe(90);
    expect(tuned.stopMult).toBe(1);
    expect(tuned.useBuy1).toBe(false);
    expect(tuned.requireVegas).toBe(false);
    expect(tuned.takeProfitR).toBe(1);
  });
});
