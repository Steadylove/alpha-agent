import { describe, expect, it } from "vitest";
import { addMonths, calculateValuation, forwardEps, fundamentalHash, parseValuation, updateReasons } from "@/lib/fundamental/engine";
import { fundamentalFixture, fundamentalNow as now } from "./fixtures/fundamental";

describe("independent fundamental valuation", () => {
  it("calculates auditable forward PE scenarios with preset weights", () => {
    const { valuation: v, reasons } = calculateValuation(fundamentalFixture(), { now });
    expect(reasons).toEqual([]);
    expect(v!.sixMonth.targetDate).toBe("2027-04-04");
    expect(v!.twelveMonth.targetDate).toBe("2027-10-04");
    // Apr 4 2027–Apr 4 2028: 272 days of FY2027 and 94 days of leap FY2028.
    const sixYearFraction = 272 / 365 + 94 / 366;
    expect(v!.sixMonth.bear.target).toBeCloseTo(140 * sixYearFraction);
    expect(v!.sixMonth.base.target).toBeCloseTo(200 * sixYearFraction);
    expect(v!.sixMonth.bull.target).toBeCloseTo(270 * sixYearFraction);
    expect(v!.twelveMonth.weightedTarget).toBeCloseTo(205.5 * (89 / 365 + 277 / 366));
    expect(parseValuation(v).id).toBe(v!.id);
    expect(v!.confidence).toBe("low");
  });
  it("uses different dated forward earnings for the two horizons, not half the upside", () => {
    const input = fundamentalFixture();
    for (const row of input.estimates.filter(row => row.fiscalEnd >= "2028")) {
      row.epsLow! *= 2; row.epsAvg! *= 2; row.epsHigh! *= 2;
    }
    const value = calculateValuation(input, { now }).valuation!;
    expect(value.twelveMonth.base.eps).toBeGreaterThan(value.sixMonth.base.eps);
    expect(value.sixMonth.base.multiple).toBeCloseTo(value.twelveMonth.base.multiple);
  });
  it("does not interpolate across a missing fiscal year or invent sparse/negative estimates", () => {
    const estimates = fundamentalFixture().estimates;
    expect(forwardEps(estimates.filter(row => row.fiscalEnd !== "2027-12-31"), "2027-04-04")).toBeNull();
    expect(forwardEps(estimates.map(row => ({ ...row, analystCount: 2 })), "2027-04-04")).toBeNull();
    expect(forwardEps(estimates.map(row => ({ ...row, epsAvg: -1 })), "2027-04-04")).toBeNull();
    expect(forwardEps([...estimates, estimates[0]], "2027-04-04")).toBeNull();
  });
  it("excludes wrong industry, duplicate, self, stale and extreme peer multiples", () => {
    const input = fundamentalFixture();
    input.peers[0].industry = "Different";
    input.peers.push(input.peers[1]);
    input.peers[2].price = 100000;
    expect(calculateValuation(input, { now }).valuation).toBeNull();
  });
  it.each(["Financial Services", "Real Estate"])("leaves %s to a supported model", sector => {
    const input = fundamentalFixture(); input.sector = sector;
    expect(calculateValuation(input, { now }).valuation).toBeNull();
  });
  it("does not adjust reported EPS to bypass suspicious earnings or missing FCF", () => {
    const input = fundamentalFixture(); input.financials!.netIncome = 1000;
    expect(calculateValuation(input, { now }).reasons.join()).toContain("Normalized");
    input.financials!.netIncome = 100; input.financials!.freeCashFlow = null;
    expect(calculateValuation(input, { now }).valuation).toBeNull();
  });
  it("current-price movement never creates a revision", () => {
    const input = fundamentalFixture(), value = calculateValuation(input, { now }).valuation!;
    input.quote!.price *= 2;
    expect(fundamentalHash(input)).toBe(value.inputHash);
    expect(updateReasons(value, input, now)).toEqual([]);
    input.peers.forEach(peer => { peer.price *= 1.1; });
    expect(updateReasons(value, input, now)).toEqual([]);
    input.peers.forEach(peer => { peer.price *= 1.1; });
    expect(updateReasons(value, input, now).join()).toContain("15%");
  });
  it("reconciles target revision to earnings and multiple contributions", () => {
    const input = fundamentalFixture(), previous = calculateValuation(input, { now }).valuation!;
    input.estimates.forEach(row => { row.epsLow! *= 1.2; row.epsAvg! *= 1.2; row.epsHigh! *= 1.2; });
    input.peers.forEach(peer => { peer.price *= 1.3; });
    const next = calculateValuation(input, { now, previous }).valuation!;
    expect(next.revision!.earningsContribution + next.revision!.multipleContribution)
      .toBeCloseTo(next.revision!.newTarget - next.revision!.previousTarget, 8);
  });
  it("detects a modified saved target and clamps calendar month ends", () => {
    const value = calculateValuation(fundamentalFixture(), { now }).valuation!;
    value.twelveMonth.weightedTarget++;
    expect(() => parseValuation(value)).toThrow();
    expect(addMonths("2028-02-29", 12)).toBe("2029-02-28");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
  });
});
