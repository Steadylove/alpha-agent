import { describe, expect, it } from "vitest";
import { calculateValuation } from "@/lib/fundamental/engine";
import { peerSensitivity } from "@/lib/fundamental/sensitivity";
import { fundamentalFixture, fundamentalNow as now } from "./fixtures/fundamental";

describe("saved peer sample sensitivity", () => {
  it("does not produce a below-minimum peer valuation when only three peers exist", () => {
    const value = calculateValuation(fundamentalFixture(), { now }).valuation!;
    expect(peerSensitivity(value)).toEqual({ status: "insufficient", sampleCount: 3, low: null, high: null, maxChangePct: null });
  });

  it("matches the engine on every independently reduced peer sample without changing the published record", () => {
    const input = fundamentalFixture();
    input.peers.push({ ...input.peers[0], symbol: "PEERD", price: 400 });
    const value = calculateValuation(input, { now }).valuation!, original = JSON.stringify(value);
    const targets = input.peers.map((_, index) => calculateValuation({ ...input,
      peers: input.peers.filter((_, i) => i !== index) }, { now }).valuation!.twelveMonth.weightedTarget);
    const result = peerSensitivity(value);
    expect(result.status).toBe("ready");
    expect(result.low).toBeCloseTo(Math.min(...targets));
    expect(result.high).toBeCloseTo(Math.max(...targets));
    expect(result.maxChangePct).toBeCloseTo(Math.max(...targets.map(target => Math.abs(target / value.twelveMonth.weightedTarget - 1) * 100)));
    expect(JSON.stringify(value)).toBe(original);
  });

  it("has zero variation for identical multiples", () => {
    const input = fundamentalFixture();
    input.peers.push({ ...input.peers[0], symbol: "PEERD" });
    input.peers.forEach(peer => { peer.price = 200; });
    const value = calculateValuation(input, { now }).valuation!, result = peerSensitivity(value);
    expect(result.maxChangePct).toBeCloseTo(0);
    expect(result.low).toBeCloseTo(value.twelveMonth.weightedTarget);
    expect(result.high).toBeCloseTo(value.twelveMonth.weightedTarget);
  });
});
