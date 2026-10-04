import { describe, expect, it, vi } from "vitest";
import { generateFundamentalAnalysis, SEC_SCENARIO_FACT_ANALYST_CONTRACT_VERSION, verifyFundamentalAnalysis } from "@/lib/fundamental/analyst";
import { buildSecAnalystCatalogV3 } from "@/lib/fundamental/analystCatalogV3";
import { calculateValuation } from "@/lib/fundamental/engine";
import type { FundamentalValuation } from "@/lib/fundamental/types";
import { fundamentalNow as now } from "./fixtures/fundamental";
import { fundamentalScenarioFixture, fundamentalScenarioStateFixture } from "./fixtures/fundamentalScenario";

const apiKey = "catalog-test-secret";
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop",
  message: { content: JSON.stringify(value) } }] }));
function selectionFor(valuation: FundamentalValuation) {
  const catalog = buildSecAnalystCatalogV3(valuation);
  return { summary: catalog.statements.find(row => row.role === "summary")!.id,
    drivers: [catalog.statements.find(row => row.id.includes(".operating-income-margin."))!.id],
    risks: [catalog.requiredRiskId] };
}
async function generate(valuation: FundamentalValuation, output: unknown = selectionFor(valuation)) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(output));
  const analyst = await generateFundamentalAnalysis(valuation, { apiKey, now, fetchImpl });
  return { analyst, fetchImpl };
}
function crm() {
  // Exact revenue / OI / NI / cash-flow values from the rejected real CRM explanation.
  const input = fundamentalScenarioFixture(); input.symbol = "CRM";
  Object.assign(input.scenario!.current, { revenue: 43_938_000_000, netIncome: 9_662_000_000,
    operatingIncome: 8_735_000_000, operatingCashFlow: 15_750_000_000, capex: 596_000_000, dilutedShares: 821_000_000 });
  Object.assign(input.scenario!.prior, { revenue: 39_502_000_000, netIncome: 6_663_000_000,
    operatingIncome: 7_987_000_000, operatingCashFlow: 13_169_000_000, capex: 672_000_000, dilutedShares: 962_000_000 });
  const current = input.scenario!.current;
  Object.assign(input.financials!, { revenue: current.revenue, netIncome: current.netIncome, operatingIncome: current.operatingIncome,
    freeCashFlow: current.operatingCashFlow - current.capex, reportedEps: current.netIncome / current.dilutedShares,
    dilutedWeightedShares: current.dilutedShares });
  return calculateValuation(input, { now }).valuation!;
}

describe("SEC analyst evidence catalog", () => {
  it.each([
    "经营利润率从 20.22% 提升至 19.88%（基本持平）。",
    "部分同行 SIC 与目标公司不一致或数据缺失，可能影响可比性。",
    "各公司业务结构不同。",
  ])("rejects unconstrained actual acceptance-failure text: %s", async text => {
    const freeText = { summary: { text, sourceIds: ["current"] },
      drivers: [{ text: "历史数据构成计算基线。", sourceIds: ["current"] }],
      risks: [{ text: "情景未经校准。", sourceIds: ["current"] }] };
    await expect(generateFundamentalAnalysis(fundamentalScenarioStateFixture().current!, {
      apiKey, now, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(freeText)),
    })).rejects.toThrow();
  });

  it("keeps the frozen V2 archive hash and rendering valid", () => {
    const valuation = fundamentalScenarioStateFixture().current!;
    valuation.analyst = {
      contractVersion: "fundamental-sec-scenario-analyst-v2", generatedAt: now.toISOString(), model: "deepseek-v4-pro",
      inputHash: "b1be57f146078a7f4cc82655a2eeec865cb53d8ff0c0741f8bdc90d2515f2886", usage: null,
      summary: { text: "历史基线与模型假设需要区分。", sourceIds: ["current"] },
      drivers: [{ text: "历史收入变化仅支持计算基线。", sourceIds: ["current", "prior"] }],
      risks: [{ text: "模型选择未经实证校准。", sourceIds: ["current"] }],
    };
    expect(verifyFundamentalAnalysis(valuation)).toEqual(valuation.analyst);
  });

  it("renders the real CRM decrease correctly and leaves all valuation numbers unchanged", async () => {
    const valuation = crm(), before = structuredClone(valuation);
    expect(valuation).not.toBeNull();
    const { analyst } = await generate(valuation);
    expect(analyst.contractVersion).toBe(SEC_SCENARIO_FACT_ANALYST_CONTRACT_VERSION);
    expect(analyst.drivers[0].text).toContain("20.22%");
    expect(analyst.drivers[0].text).toContain("19.88%");
    expect(analyst.drivers[0].text).toContain("下降 0.34 个百分点");
    expect(analyst.drivers[0].text).not.toContain("提升");
    expect(analyst.drivers[0].sourceIds).toEqual(["prior", "current"]);
    expect(analyst.risks[0].text).toContain("不是公司指引、分析师一致预期或发生概率");
    expect(valuation).toEqual(before);
    valuation.analyst = analyst;
    expect(verifyFundamentalAnalysis(valuation)).toEqual(analyst);
  });

  it("binds facts to issuer, metric, period and sources and excludes rejected candidates completely", async () => {
    const valuation = crm();
    const rejected = { ...valuation.input.scenario!.peers[0], symbol: "REJECTED",
      current: { ...valuation.input.scenario!.peers[0].current, sourceIds: ["rejected-source"] } };
    valuation.input.scenario!.peers.push(rejected);
    valuation.input.sources.push({ ...valuation.input.sources[0], id: "rejected-source", label: "unrelated candidate" });
    valuation.input.warnings.push("REJECTED SIC 与目标不一致。", "Missing foreign company identity.");
    valuation.assumptions.push(...valuation.input.warnings);
    const { fetchImpl } = await generate(valuation);
    const request = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    const catalog = JSON.parse(request.messages[1].content);
    expect(request.messages[1].content).not.toMatch(/REJECTED|rejected-source|unrelated candidate|Missing foreign/);
    expect(catalog.facts.find((fact: { id: string }) => fact.id === "target.crm.current.operating-income.2026-06-30"))
      .toMatchObject({ entity: "CRM", metric: "operating-income", periodStart: "2025-07-01", periodEnd: "2026-06-30",
        value: 8_735_000_000, sourceIds: ["current"] });
    expect(catalog.facts.find((fact: { id: string }) => fact.id === "peer.peera.operating-income.2026-06-30"))
      .toMatchObject({ entity: "PEERA", sourceIds: ["PEERA"] });
    const risk = catalog.statements.find((row: { id: string }) => row.id.includes(".peer-sample."));
    expect(risk.text).toContain("PEERA、PEERB、PEERC");
    expect(risk.sourceIds).toEqual(["PEERA", "PEERB", "PEERC"]);
  });

  it("rejects cross-issuer source ownership before any request", async () => {
    const valuation = crm(); valuation.input.scenario!.current.sourceIds = ["PEERA"];
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(generateFundamentalAnalysis(valuation, { apiKey, now, fetchImpl })).rejects.toThrow("归属冲突");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["unknown", "rejected-peer", "wrong-owner", "wrong-role", "duplicate", "missing-core-risk", "extra-text"])
    ("rejects invalid or ungrounded selection: %s", async kind => {
      const valuation = crm(), selection = selectionFor(valuation);
      const catalog = buildSecAnalystCatalogV3(valuation);
      let output: unknown = selection;
      if (kind === "unknown") selection.drivers = ["target.crm.unknown.2026-06-30"];
      if (kind === "rejected-peer") selection.drivers = ["peer.rejected.multiple.2026-06-30"];
      if (kind === "wrong-owner") selection.drivers = [selection.drivers[0].replace("target.crm", "peer.peera")];
      if (kind === "wrong-role") selection.drivers = [catalog.statements.find(row => row.id.includes(".peer-sample."))!.id];
      if (kind === "duplicate") selection.drivers.push(selection.drivers[0]);
      if (kind === "missing-core-risk") selection.risks = [catalog.statements.find(row => row.id.includes(".fixed-shares."))!.id];
      if (kind === "extra-text") output = { ...selection, text: "各公司业务结构不同。" };
      await expect(generate(valuation, output)).rejects.toThrow();
    });

  it.each(["reverse-direction", "unrelated-source", "extra-claim", "changed-selection", "missing-selection"])
    ("rejects archived render tampering: %s", async kind => {
      const valuation = crm(); valuation.analyst = (await generate(valuation)).analyst;
      if (kind === "reverse-direction") valuation.analyst.drivers[0].text = "经营利润率从 20.22% 提升至 19.88%（基本持平）。";
      if (kind === "unrelated-source") valuation.analyst.drivers[0].sourceIds = ["PEERA"];
      if (kind === "extra-claim") valuation.analyst.drivers[0].text += "各公司业务结构不同。";
      if (kind === "changed-selection") valuation.analyst.selection!.drivers = ["peer.peera.multiple.2026-06-30"];
      if (kind === "missing-selection") delete valuation.analyst.selection;
      expect(() => verifyFundamentalAnalysis(valuation)).toThrow();
    });

  it("invalidates V3 when relevant evidence or model assumptions change", async () => {
    for (const change of ["income", "assumption", "selected-peer"] as const) {
      const valuation = crm(); valuation.analyst = (await generate(valuation)).analyst;
      if (change === "income") valuation.input.scenario!.current.operatingIncome += 1;
      if (change === "assumption") valuation.scenarioAssumptions!.revenueGrowth.base += 0.01;
      if (change === "selected-peer") valuation.peers[0].pe += 1;
      expect(() => verifyFundamentalAnalysis(valuation)).toThrow("与估值证据不一致");
    }
  });

  it("rejects malformed output and key echoes without exposing credentials", async () => {
    const valuation = crm();
    for (const output of [{ ...selectionFor(valuation), secret: apiKey }, { summary: apiKey, drivers: [apiKey], risks: [apiKey] }, null]) {
      let error: unknown;
      try { await generate(valuation, output); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(apiKey);
    }
  });
});
