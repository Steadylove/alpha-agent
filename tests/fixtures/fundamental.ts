import type { AnnualEstimate, FundamentalInput, FundamentalState } from "@/lib/fundamental/types";
import { calculateValuation } from "@/lib/fundamental/engine";

export const fundamentalNow = new Date("2026-10-04T12:00:00.000Z");
export function fundamentalFixture(now = fundamentalNow): FundamentalInput {
  const observedAt = now.toISOString();
  const estimates = (sourceId: string): AnnualEstimate[] => [2025, 2026, 2027, 2028, 2029].map(year => ({
    fiscalEnd: `${year}-12-31`, epsLow: 8, epsAvg: 10, epsHigh: 12, revenueAvg: 1000, analystCount: 5, sourceId,
  }));
  return {
    version: 1, symbol: "ACME", companyName: "Acme", industry: "Software", sector: "Technology", currency: "USD",
    isEtf: false, isAdr: false, observedAt, quote: { price: 100, observedAt }, earningsBasis: "non-gaap-consensus",
    financials: { fiscalEnd: "2025-12-31", filedAt: "2026-02-01", currency: "USD", revenue: 1000,
      netIncome: 100, operatingIncome: 150, reportedEps: 7, freeCashFlow: 120, cash: 200, debt: 100,
      dilutedWeightedShares: 15, latestQuarter: { fiscalEnd: "2026-06-30", filedAt: "2026-08-01", eps: 2 }, sourceIds: ["financials"] },
    estimates: estimates("estimates"), peers: ["PEERA", "PEERB", "PEERC"].map((symbol, i) => ({
      symbol, industry: "Software", currency: "USD", price: [150, 200, 250][i], observedAt,
      estimates: estimates(symbol), sourceIds: [symbol],
    })),
    sources: ["financials", "estimates", "PEERA", "PEERB", "PEERC"].map(id => ({
      id, label: id, url: `https://example.com/${id}`, observedAt, publishedAt: null,
    })), warnings: [],
  };
}

export function fundamentalStateFixture(now = fundamentalNow): FundamentalState {
  const current = calculateValuation(fundamentalFixture(now), { now }).valuation!;
  if (!current) throw new Error("Fixture not valid");
  return { version: 1, symbol: "ACME", status: "ready", checkedAt: now.toISOString(),
    nextCheckAt: new Date(now.getTime() + 86400000).toISOString(), reasons: [], current,
    latestQuote: current.input.quote, eventIds: [], analystStatus: "not-requested" };
}
