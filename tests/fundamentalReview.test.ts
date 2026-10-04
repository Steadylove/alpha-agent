import { describe, expect, it } from "vitest";
import { calculateValuation, forwardEps, parseValuation, peerMultiples, valuationId } from "../src/lib/fundamental/engine";
import type { AnnualEstimate, FundamentalInput } from "../src/lib/fundamental/types";

const now = new Date("2026-10-04T01:00:00.000Z");
function fixture(): FundamentalInput {
  const estimates: AnnualEstimate[] = [2026, 2027, 2028].map(year => ({
    fiscalEnd: `${year}-12-31`, epsLow: 4, epsAvg: 5, epsHigh: 6,
    revenueAvg: 1_000, analystCount: 5, sourceId: "source:estimates",
  }));
  return {
    version: 1, symbol: "TEST", companyName: "Test company", sector: "Technology", industry: "Software",
    currency: "USD", isEtf: false, isAdr: false, observedAt: now.toISOString(),
    quote: { price: 100, observedAt: now.toISOString() }, earningsBasis: "non-gaap-consensus",
    financials: { fiscalEnd: "2025-12-31", filedAt: "2026-02-01", currency: "USD",
      revenue: 900, netIncome: 100, operatingIncome: 150, reportedEps: 2, freeCashFlow: 90,
      cash: 100, debt: 10, dilutedWeightedShares: 50,
      latestQuarter: { fiscalEnd: "2026-06-30", filedAt: "2026-08-01", eps: 0.6 },
      sourceIds: ["source:financials"] },
    estimates,
    peers: ["AAA", "BBB", "CCC"].map(symbol => ({ symbol, industry: "Software", currency: "USD",
      price: 100, observedAt: now.toISOString(), estimates: structuredClone(estimates), sourceIds: ["source:estimates"] })),
    sources: ["source:financials", "source:estimates"].map(id => ({
      id, label: id, url: "https://example.com/evidence", observedAt: now.toISOString(), publishedAt: null,
    })), warnings: [],
  };
}

describe("fundamental independent edge-case review", () => {
  it("has a supported positive control", () => {
    const value = calculateValuation(fixture(), { now }).valuation;
    expect(value).not.toBeNull();
    expect(parseValuation(value)).toEqual(value);
  });

  it("rejects a source publication later on the same day than the observation", () => {
    const input = fixture();
    input.sources[0].publishedAt = "2026-10-04T23:00:00.000Z";
    expect(calculateValuation(input, { now }).valuation).toBeNull();
  });

  it("excludes peer quotes from after the collection cutoff", () => {
    const input = fixture();
    input.peers[0].observedAt = "2026-10-04T02:00:00.000Z";
    expect(peerMultiples(input, "2026-10-04").map(peer => peer.symbol)).not.toContain("AAA");
  });

  it("does not fill a missing fiscal year with an extrapolated estimate", () => {
    const estimates = fixture().estimates.filter(row => row.fiscalEnd !== "2027-12-31");
    expect(forwardEps(estimates, "2027-01-01")).toBeNull();
  });

  it("weights EPS by days in each fiscal year across a leap year", () => {
    const estimates = fixture().estimates;
    estimates[1].epsAvg = 12;
    estimates[2].epsAvg = 24;
    const actual = forwardEps(estimates, "2027-07-01");
    const expected = 12 * 184 / 365 + 24 * 182 / 366;
    expect(actual).toBeCloseTo(expected, 10);
  });

  it("revision earnings and multiple contributions reconcile to target movement", () => {
    const first = calculateValuation(fixture(), { now }).valuation!;
    const input = fixture();
    input.estimates.forEach(estimate => { estimate.epsLow! *= 1.2; estimate.epsAvg! *= 1.2; estimate.epsHigh! *= 1.2; });
    input.peers.forEach(peer => { peer.price *= 0.8; });
    const second = calculateValuation(input, { now, previous: first }).valuation!;
    expect(second.revision!.earningsContribution + second.revision!.multipleContribution)
      .toBeCloseTo(second.twelveMonth.weightedTarget - first.twelveMonth.weightedTarget, 10);
  });

  it("rejects publication preceding the financial observation even when its ID is recomputed", () => {
    const value = calculateValuation(fixture(), { now }).valuation!;
    value.publishedAt = "2026-10-04T00:00:00.000Z";
    value.id = valuationId(value);
    expect(() => parseValuation(value)).toThrow("发布时间校验失败");
  });

  it("rejects a nonpositive validity interval even when its ID is recomputed", () => {
    const value = calculateValuation(fixture(), { now }).valuation!;
    value.validUntil = value.publishedAt;
    value.id = valuationId(value);
    expect(() => parseValuation(value)).toThrow("发布时间校验失败");
  });

  it("rejects inconsistent scenario arithmetic even when its ID is recomputed", () => {
    const value = calculateValuation(fixture(), { now }).valuation!;
    value.twelveMonth.base.target += 1;
    value.id = valuationId(value);
    expect(() => parseValuation(value)).toThrow("估值计算校验失败");
  });
});
