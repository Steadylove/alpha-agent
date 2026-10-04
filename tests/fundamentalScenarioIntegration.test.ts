import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateFundamentalAnalysis, SEC_SCENARIO_FACT_ANALYST_CONTRACT_VERSION, verifyFundamentalAnalysis } from "@/lib/fundamental/analyst";
import { parseValuation, valuationId } from "@/lib/fundamental/engine";
import { refreshFundamentalSymbol } from "@/lib/fundamental/service";
import { createSecFundamentalProvider } from "@/lib/fundamental/secProvider";
import { getFundamentalPage, readFundamentalState, saveFundamentalState } from "@/lib/fundamental/store";
import { SEC_SCENARIO_RULE } from "@/lib/fundamental/types";
import { fundamentalNow as now, fundamentalStateFixture } from "./fixtures/fundamental";
import { fundamentalScenarioFixture, fundamentalScenarioStateFixture } from "./fixtures/fundamentalScenario";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "fundamental-sec-integration-")); dirs.push(dir); return dir; };
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.unstubAllEnvs(); vi.useRealTimers(); });
const aiFetch = () => vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
  const catalog = JSON.parse(JSON.parse(init!.body as string).messages[1].content);
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
    summary: catalog.statements.find((row: { role: string }) => row.role === "summary").id,
    drivers: [catalog.statements.find((row: { role: string }) => row.role === "driver").id],
    risks: [catalog.requiredRiskId],
  }) } }] }));
});

describe("SEC scenario archive and AI boundary", () => {
  it("validates newly collected evidence against completion time rather than request-start time", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const collectedAt = new Date(now.getTime() + 5000);
    const result = await refreshFundamentalSymbol("ACME", {}, {
      read: () => null, save: vi.fn(), collect: async () => {
        vi.setSystemTime(collectedAt); return fundamentalScenarioFixture(collectedAt);
      },
    });
    expect(result.state.status).toBe("ready");
    expect(result.state.current!.publishedAt).toBe(collectedAt.toISOString());
    expect(parseValuation(result.state.current!).rule).toBe(SEC_SCENARIO_RULE);
  });
  it("uses a distinct explanation contract and freezes it against persisted scenario evidence", async () => {
    const valuation = fundamentalScenarioStateFixture().current!, fetchImpl = aiFetch();
    const analyst = await generateFundamentalAnalysis(valuation, { apiKey: "test-only-key", now, fetchImpl });
    expect(analyst.contractVersion).toBe(SEC_SCENARIO_FACT_ANALYST_CONTRACT_VERSION);
    const body = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(body.messages[0].content).toContain("不是公司指引、分析师一致预期");
    const evidence = JSON.parse(body.messages[1].content);
    expect(evidence.facts.find((row: { id: string }) => row.id === "model.acme.base-growth.2026-10-04").value)
      .toBe(valuation.scenarioAssumptions!.revenueGrowth.base);
    expect(evidence.facts.find((row: { id: string }) => row.id === "target.acme.current.revenue.2026-06-30").value)
      .toBe(valuation.input.scenario!.current.revenue);
    expect(evidence).not.toHaveProperty("quote");
    expect(body.messages[1].content).not.toContain("https://");
    valuation.analyst = analyst;
    expect(verifyFundamentalAnalysis(valuation)).toEqual(analyst);
    valuation.scenarioAssumptions!.revenueGrowth.base += 0.01;
    expect(() => verifyFundamentalAnalysis(valuation)).toThrow("与估值证据不一致");
  });

  it("refuses attaching legacy explanation contracts to reported scenarios", async () => {
    const valuation = fundamentalScenarioStateFixture().current!;
    valuation.analyst = await generateFundamentalAnalysis(valuation, { apiKey: "test-only-key", now, fetchImpl: aiFetch() });
    delete valuation.analyst.contractVersion;
    expect(() => verifyFundamentalAnalysis(valuation)).toThrow("归档合约不符");
  });

  it("archives a model switch without replacing the earlier known-at-entry version", async () => {
    const directory = temp(), previous = fundamentalStateFixture();
    saveFundamentalState(previous, directory);
    const later = new Date(now.getTime() + 3600000);
    const result = await refreshFundamentalSymbol("ACME", { now: later, force: true }, {
      read: symbol => readFundamentalState(symbol, directory), save: state => saveFundamentalState(state, directory),
      collect: async () => fundamentalScenarioFixture(later), analyze: async () => { throw new Error("offline"); },
    });
    expect(result.state.status).toBe("ready");
    expect(result.state.current!.rule).toBe(SEC_SCENARIO_RULE);
    expect(result.state.current!.revision).toMatchObject({ kind: "model-change", earningsContribution: 0, multipleContribution: 0 });
    const page = await getFundamentalPage("ACME", { directory, now: later, entryAt: now.toISOString() });
    expect(page.error).toBeNull(); expect(page.history).toHaveLength(2);
    expect(page.atEntry!.id).toBe(previous.current!.id);
    expect(page.state!.current!.rule).toBe(SEC_SCENARIO_RULE);
  });

  it("supplements AI without moving targets or extending expiry, and persists a valid new edition", async () => {
    const directory = temp(), previous = fundamentalScenarioStateFixture();
    saveFundamentalState(previous, directory);
    const later = new Date(now.getTime() + 86400000), fetchImpl = aiFetch();
    const input = fundamentalScenarioFixture(later); input.quote!.price = 220;
    const result = await refreshFundamentalSymbol("ACME", { now: later }, {
      read: symbol => readFundamentalState(symbol, directory), save: state => saveFundamentalState(state, directory),
      collect: async () => input,
      analyze: value => generateFundamentalAnalysis(value, { apiKey: "test-only-key", now: later, fetchImpl }),
    });
    expect(result.state.current!.twelveMonth).toEqual(previous.current!.twelveMonth);
    expect(result.state.current!.validUntil).toBe(previous.current!.validUntil);
    expect(result.state.current!.id).not.toBe(previous.current!.id);
    expect(result.state.latestQuote!.price).toBe(220);
    expect(readFundamentalState("ACME", directory)!.analystStatus).toBe("ready");
  });

  it("keeps archive validation valid when publication crosses midnight after computation", () => {
    const value = fundamentalScenarioStateFixture().current!;
    value.publishedAt = "2026-10-05T00:01:00.000Z";
    value.validUntil = "2027-01-03T00:01:00.000Z";
    value.id = valuationId(value);
    expect(parseValuation(value).anchorDate).toBe("2026-10-04");
  });

  it("saves a specific missing SEC identity reason without a request or loss of previous targets", async () => {
    const directory = temp(), previous = fundamentalScenarioStateFixture();
    saveFundamentalState(previous, directory);
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await refreshFundamentalSymbol("ACME", { now, force: true }, {
      read: symbol => readFundamentalState(symbol, directory), save: state => saveFundamentalState(state, directory),
      collect: createSecFundamentalProvider({ userAgent: "", fetchImpl }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.state.status).toBe("stale");
    expect(result.state.current!.id).toBe(previous.current!.id);
    expect(result.state.reasons.join()).toContain("SEC_USER_AGENT");
    expect(readFundamentalState("ACME", directory)!.status).toBe("stale");
  });
});
