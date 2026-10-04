import { describe, expect, it } from "vitest";
import { calculateValuation, fundamentalHash, parseValuation, peerMultiples, updateReasons, validateInput, valuationId } from "@/lib/fundamental/engine";
import { SEC_SCENARIO_RULE, type FundamentalInput } from "@/lib/fundamental/types";
import { fundamentalFixture, fundamentalNow as now } from "./fixtures/fundamental";
import { fundamentalScenarioFixture } from "./fixtures/fundamentalScenario";

function valuation(input = fundamentalScenarioFixture()) {
  const result = calculateValuation(input, { now });
  expect(result.reasons).toEqual([]);
  expect(result.valuation).not.toBeNull();
  return result.valuation!;
}

function mirrorFinancials(input: FundamentalInput) {
  const current = input.scenario!.current, f = input.financials!;
  f.revenue = current.revenue; f.netIncome = current.netIncome; f.operatingIncome = current.operatingIncome;
  f.freeCashFlow = current.operatingCashFlow - current.capex;
  f.dilutedWeightedShares = current.dilutedShares; f.reportedEps = current.netIncome / current.dilutedShares;
}

describe("reported financial scenario model", () => {
  it("computes hand-checkable annualized earnings, peer quantiles and weighted targets", () => {
    const value = valuation();
    expect(value.rule).toBe(SEC_SCENARIO_RULE);
    expect(value.method).toBe("Reported earnings scenario P/E");
    expect(value.scenarioAssumptions).toMatchObject({ baseRevenue: 1100, dilutedShares: 10, netMargin: { base: 0.1 } });
    expect(value.scenarioAssumptions!.netMargin.bear).toBeCloseTo(0.09);
    expect(value.scenarioAssumptions!.revenueGrowth.base).toBeCloseTo(0.1);
    expect(value.scenarioAssumptions!.netMargin.bull).toBeCloseTo(0.11);
    expect(value.peers).toEqual([
      { symbol: "PEERA", reportedEps: 10, pe: 15 }, { symbol: "PEERB", reportedEps: 10, pe: 20 },
      { symbol: "PEERC", reportedEps: 10, pe: 25 },
    ]);
    expect(value.twelveMonth.bear.eps).toBeCloseTo(10.395);
    expect(value.twelveMonth.base.eps).toBeCloseTo(12.1);
    expect(value.twelveMonth.bull.eps).toBeCloseTo(13.915);
    expect(value.twelveMonth.weightedTarget).toBeCloseTo(247.754375);
    expect(value.sixMonth.base.eps).toBeCloseTo(1100 * Math.sqrt(1.1) * 0.1 / 10);
    expect(value.sixMonth.bear.multiple).toBe(17.5);
    expect(value.sixMonth.bull.multiple).toBe(22.5);
    expect(value.sixMonth).toMatchObject({ targetDate: "2027-04-04", earningsStart: "2026-04-04", earningsEnd: "2027-04-04" });
    expect(value.twelveMonth).toMatchObject({ targetDate: "2027-10-04", earningsStart: "2026-10-04", earningsEnd: "2027-10-04" });
    expect(value.confidence).toBe("low");
    expect(value.assumptions.join()).toContain("不是分析师一致预期");
    expect(parseValuation(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it.each([[2, 0.2, 0.15, 0.25], [0.5, -0.15, -0.2, -0.1]])("caps the observed revenue ratio %s rather than projecting it without bounds", (ratio, base, bear, bull) => {
    const input = fundamentalScenarioFixture();
    input.scenario!.current.revenue = input.scenario!.prior.revenue * ratio;
    mirrorFinancials(input);
    const value = valuation(input), assumptions = value.scenarioAssumptions!;
    expect(assumptions.observedRevenueGrowth).toBeCloseTo(ratio - 1);
    expect(assumptions.revenueGrowth.base).toBeCloseTo(base);
    expect(assumptions.revenueGrowth.bear).toBeCloseTo(bear);
    expect(assumptions.revenueGrowth.bull).toBeCloseTo(bull);
    expect(value.sixMonth.bear.target).toBeLessThanOrEqual(value.sixMonth.base.target);
    expect(value.twelveMonth.base.target).toBeLessThanOrEqual(value.twelveMonth.bull.target);
  });

  it("does not invent margin recovery when the current margin has deteriorated", () => {
    const input = fundamentalScenarioFixture(); input.scenario!.current.netIncome = 88;
    mirrorFinancials(input);
    const value = valuation(input);
    expect(value.scenarioAssumptions!.netMargin).toEqual({ bear: 0.07200000000000001, base: 0.08, bull: 0.08 });
  });

  it("needs no analyst estimates, but refuses missing periods and incompatible legacy inputs", () => {
    const input = fundamentalScenarioFixture();
    expect(input.estimates).toEqual([]);
    delete input.scenario;
    expect(calculateValuation(input, { now }).reasons.join()).toContain("连续两期");
    const mixed = fundamentalScenarioFixture(); mixed.estimates = fundamentalFixture().estimates;
    expect(calculateValuation(mixed, { now }).reasons.join()).toContain("不能混用");
  });

  it.each([
    (input: FundamentalInput) => { input.scenario!.current.periodStart = "2025-08-01"; },
    (input: FundamentalInput) => { input.scenario!.prior.periodEnd = "2025-06-29"; },
    (input: FundamentalInput) => { input.scenario!.current.latestQuarterEnd = "2026-03-31"; },
    (input: FundamentalInput) => { input.scenario!.prior.filedAt = "2027-01-01"; },
    (input: FundamentalInput) => { input.scenario!.current.latestQuarterFiledAt = "2027-01-01"; },
    (input: FundamentalInput) => { input.sources[0].publishedAt = "2027-01-01"; },
    (input: FundamentalInput) => { input.sources[0].observedAt = "2026-10-05T00:00:00.000Z"; },
    (input: FundamentalInput) => { input.scenario!.current.sourceIds = ["missing-source"]; },
    (input: FundamentalInput) => { input.scenario!.current.sourceIds = []; },
  ])("refuses noncontiguous, future or unverifiable reported evidence %#", mutate => {
    const input = fundamentalScenarioFixture(); mutate(input);
    expect(calculateValuation(input, { now }).valuation).toBeNull();
  });

  it.each([
    (input: FundamentalInput) => { input.scenario!.prior.netIncome = -1; },
    (input: FundamentalInput) => { input.scenario!.current.operatingCashFlow = 1; },
    (input: FundamentalInput) => { input.scenario!.prior.capex = -1; },
    (input: FundamentalInput) => { input.scenario!.current.netIncome = 240; },
    (input: FundamentalInput) => { input.scenario!.current.latestQuarterEps = 0; },
  ])("does not paper over poor reported earnings/cashflow quality %#", mutate => {
    const input = fundamentalScenarioFixture(); mutate(input); mirrorFinancials(input);
    expect(calculateValuation(input, { now }).valuation).toBeNull();
  });

  it.each(["Financial Services", "Real Estate"])("does not apply this P/E model to %s", sector => {
    const input = fundamentalScenarioFixture(); input.sector = sector;
    expect(calculateValuation(input, { now }).valuation).toBeNull();
  });
  it("does not apply this P/E model to ADR, funds or non-USD reports", () => {
    for (const mutate of [(input: FundamentalInput) => { input.isAdr = true; },
      (input: FundamentalInput) => { input.isEtf = true; },
      (input: FundamentalInput) => { input.financials!.currency = "EUR"; }]) {
      const input = fundamentalScenarioFixture(); mutate(input);
      expect(calculateValuation(input, { now }).valuation).toBeNull();
    }
  });

  it("requires three independent same-industry, timely, positive cashflow peers", () => {
    for (const mutate of [(input: FundamentalInput) => { input.scenario!.peers[0].symbol = input.symbol; },
      (input: FundamentalInput) => { input.scenario!.peers[0].symbol = input.scenario!.peers[1].symbol; },
      (input: FundamentalInput) => { input.scenario!.peers[0].industry = "Other"; },
      (input: FundamentalInput) => { input.scenario!.peers[0].currency = "EUR"; },
      (input: FundamentalInput) => { input.scenario!.peers[0].observedAt = "2026-09-20T12:00:00.000Z"; },
      (input: FundamentalInput) => { input.scenario!.peers[0].observedAt = "2026-10-05T12:00:00.000Z"; },
      (input: FundamentalInput) => { input.scenario!.peers[0].current.capex = 10000; },
      (input: FundamentalInput) => { input.scenario!.peers[0].current.sourceIds = ["absent"]; },
      (input: FundamentalInput) => { input.scenario!.peers[0].price = 100000; }]) {
      const input = fundamentalScenarioFixture(); mutate(input);
      const result = calculateValuation(input, { now });
      expect(result.valuation).toBeNull();
      expect(result.reasons.join()).toContain("不足 3 家");
    }
  });

  it("keeps the 190-day report freshness check on current periods, not last year's comparison period", () => {
    const input = fundamentalScenarioFixture();
    expect(validateInput(input, now).reasons).toEqual([]);
    const late = new Date("2027-02-01T12:00:00.000Z");
    const stale = fundamentalScenarioFixture(late);
    expect(calculateValuation(stale, { now: late }).reasons.join()).toContain("季度过期");
  });

  it("does not let display financials diverge from calculation evidence", () => {
    const input = fundamentalScenarioFixture(); input.financials!.reportedEps = 99;
    expect(calculateValuation(input, { now }).reasons.join()).toContain("展示口径");
  });

  it("ignores quote/retrieval movements, but tracks changed filings and material peer pricing", () => {
    const input = fundamentalScenarioFixture(), previous = valuation(input);
    input.quote!.price = 100000;
    expect(fundamentalHash(input)).toBe(previous.inputHash);
    expect(updateReasons(previous, input, now)).toEqual([]);
    expect(valuation(input).twelveMonth).toEqual(previous.twelveMonth);
    input.scenario!.peers.forEach(peer => { peer.price *= 1.1; });
    expect(fundamentalHash(input)).toBe(previous.inputHash);
    expect(updateReasons(previous, input, now)).toEqual([]);
    input.scenario!.peers.forEach(peer => { peer.price *= 1.1; });
    expect(updateReasons(previous, input, now).join()).toContain("15%");
    input.scenario!.peers[0].current.netIncome += 1;
    expect(fundamentalHash(input)).not.toBe(previous.inputHash);
    expect(updateReasons(previous, input, now).join()).toContain("财务证据更新");
    expect(peerMultiples(input, "2026-10-04")[0].reportedEps).toBe(10.1);
  });

  it("treats source-only retrieval metadata as provenance, not a financial change", () => {
    const input = fundamentalScenarioFixture(), original = fundamentalHash(input);
    input.observedAt = "2026-10-04T13:00:00.000Z";
    input.sources.forEach(source => { source.observedAt = input.observedAt; });
    input.scenario!.current.sourceIds = ["re-fetched-report"];
    input.scenario!.peers[0].observedAt = input.observedAt;
    expect(fundamentalHash(input)).toBe(original);
  });

  it("reconciles same-model revisions and separates a model change from earnings/multiple attribution", () => {
    const input = fundamentalScenarioFixture(), previous = valuation(input);
    input.scenario!.current.revenue += 50; input.scenario!.current.netIncome += 5; mirrorFinancials(input);
    input.scenario!.peers.forEach(peer => { peer.price *= 1.2; });
    const next = calculateValuation(input, { now, previous }).valuation!;
    expect(next.revision!.earningsContribution + next.revision!.multipleContribution)
      .toBeCloseTo(next.twelveMonth.weightedTarget - previous.twelveMonth.weightedTarget);
    expect(parseValuation(next).id).toBe(next.id);
    const legacy = calculateValuation(fundamentalFixture(), { now }).valuation!;
    const switched = calculateValuation(input, { now, previous: legacy }).valuation!;
    expect(switched.revision).toMatchObject({ kind: "model-change", earningsContribution: 0, multipleContribution: 0 });
    expect(switched.revision!.modelContribution).toBeCloseTo(switched.twelveMonth.weightedTarget - legacy.twelveMonth.weightedTarget);
    expect(switched.updateReasons.join()).toContain("方法变更");
    expect(parseValuation(switched).id).toBe(switched.id);
    const back = calculateValuation(fundamentalFixture(), { now, previous }).valuation!;
    expect(back.revision!.kind).toBe("model-change");
    expect(parseValuation(back).id).toBe(back.id);
  });

  it("rejects tampered assumptions, multiples and earnings even after the attacker recomputes the content ID", () => {
    for (const mutate of [(v: ReturnType<typeof valuation>) => { v.scenarioAssumptions!.revenueGrowth.base += 0.01; },
      (v: ReturnType<typeof valuation>) => { v.peers[0].reportedEps! += 1; },
      (v: ReturnType<typeof valuation>) => { v.peers[0].pe += 1; },
      (v: ReturnType<typeof valuation>) => { v.twelveMonth.base.eps += 1; v.twelveMonth.base.target = v.twelveMonth.base.eps * v.twelveMonth.base.multiple;
        v.twelveMonth.weightedTarget = v.twelveMonth.bear.target * 0.2 + v.twelveMonth.base.target * 0.55 + v.twelveMonth.bull.target * 0.25; },
      (v: ReturnType<typeof valuation>) => { v.input.scenario!.current.filedAt = "2027-01-01"; v.input.financials!.filedAt = "2027-01-01";
        v.inputHash = fundamentalHash(v.input); },
      (v: ReturnType<typeof valuation>) => { v.peers[0].ntmEps = v.peers[0].reportedEps; },
      (v: ReturnType<typeof valuation>) => { v.method = "Forward P/E"; }]) {
      const value = valuation(); mutate(value); value.id = valuationId(value);
      expect(() => parseValuation(value)).toThrow();
    }
  });

  it("keeps original targets and anchor valid when later AI publication crosses midnight", () => {
    const value = valuation(); value.publishedAt = "2026-10-05T00:00:05.000Z";
    value.validUntil = "2027-01-03T00:00:05.000Z"; value.id = valuationId(value);
    expect(parseValuation(value).anchorDate).toBe("2026-10-04");
  });

  it("retains legacy input and valuation serialization without introducing v2 properties", () => {
    const legacyInput = fundamentalFixture(), legacy = calculateValuation(legacyInput, { now }).valuation!;
    expect(legacy.input).not.toHaveProperty("scenario");
    expect(legacy).not.toHaveProperty("scenarioAssumptions");
    expect(legacy.peers.every(peer => peer.ntmEps != null && peer.reportedEps == null)).toBe(true);
    expect(parseValuation(legacy)).toEqual(legacy);
  });
});
