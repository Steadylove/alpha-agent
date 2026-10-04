import { calculateValuation } from "@/lib/fundamental/engine";
import type { FundamentalInput, FundamentalState, ReportedPeriod } from "@/lib/fundamental/types";
import { fundamentalNow } from "./fundamental";

/** Synthetic dollars/shares, chosen so all normalized EPS and peer multiples are hand-checkable. */
export function fundamentalScenarioFixture(now = fundamentalNow): FundamentalInput {
  const observedAt = now.toISOString();
  const current: ReportedPeriod = { periodStart: "2025-07-01", periodEnd: "2026-06-30", filedAt: "2026-08-01",
    revenue: 1100, netIncome: 132, operatingIncome: 180, operatingCashFlow: 160, capex: 20, dilutedShares: 10,
    latestQuarterEnd: "2026-06-30", latestQuarterFiledAt: "2026-08-01", latestQuarterEps: 3.2, sourceIds: ["current"] };
  const prior: ReportedPeriod = { ...current, periodStart: "2024-07-01", periodEnd: "2025-06-30", filedAt: "2025-08-01",
    revenue: 1000, netIncome: 100, operatingIncome: 140, operatingCashFlow: 130, capex: 20, dilutedShares: 10,
    latestQuarterEnd: "2025-06-30", latestQuarterFiledAt: "2025-08-01", latestQuarterEps: 2.5, sourceIds: ["prior"] };
  const peers = ["PEERA", "PEERB", "PEERC"].map((symbol, i) => ({ symbol, industry: "Software", currency: "USD",
    observedAt, price: [150, 200, 250][i], current: { ...current, revenue: 1000, netIncome: 100, dilutedShares: 10, sourceIds: [symbol] } }));
  return { version: 1, symbol: "ACME", companyName: "Acme", industry: "Software", sector: "Technology", currency: "USD",
    isEtf: false, isAdr: false, observedAt, quote: { price: 100, observedAt }, earningsBasis: "gaap-derived-scenario",
    financials: { fiscalEnd: current.periodEnd, filedAt: current.filedAt, currency: "USD", revenue: current.revenue,
      netIncome: current.netIncome, operatingIncome: current.operatingIncome, reportedEps: current.netIncome / current.dilutedShares,
      freeCashFlow: current.operatingCashFlow - current.capex, cash: null, debt: null, dilutedWeightedShares: current.dilutedShares,
      latestQuarter: { fiscalEnd: current.latestQuarterEnd, filedAt: current.latestQuarterFiledAt, eps: current.latestQuarterEps }, sourceIds: current.sourceIds },
    estimates: [], peers: [], sources: ["current", "prior", ...peers.map(peer => peer.symbol)].map(id => ({
      id, label: `SEC ${id} synthetic fixture`, url: `https://www.sec.gov/Archives/${id}`, observedAt,
      publishedAt: id === "prior" ? prior.filedAt : current.filedAt,
    })), warnings: [], scenario: { current, prior, peers } };
}

export function fundamentalScenarioStateFixture(now = fundamentalNow): FundamentalState {
  const current = calculateValuation(fundamentalScenarioFixture(now), { now }).valuation;
  if (!current) throw new Error("Scenario fixture not valid");
  return { version: 1, symbol: "ACME", status: "ready", checkedAt: now.toISOString(),
    nextCheckAt: new Date(now.getTime() + 86400000).toISOString(), reasons: [], current,
    latestQuote: current.input.quote, eventIds: [], analystStatus: "not-requested" };
}
