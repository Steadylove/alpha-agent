import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FundamentalPanel } from "@/components/fundamental/FundamentalPanel";
import { confidenceReadout, formulaReadout } from "@/components/fundamental/readout";
import { addMonths } from "@/lib/fundamental/engine";
import { SEC_SCENARIO_RULE, type FundamentalPageData, type ReportedPeriod } from "@/lib/fundamental/types";
import { fundamentalStateFixture } from "./fixtures/fundamental";

function scenarioPage(): FundamentalPageData {
  const state = fundamentalStateFixture(), value = state.current!;
  const current: ReportedPeriod = {
    periodStart: "2025-07-01", periodEnd: "2026-06-30", filedAt: "2026-08-01",
    revenue: 1_200_000_000, netIncome: 240_000_000, operatingIncome: 300_000_000,
    operatingCashFlow: 300_000_000, capex: 70_000_000, dilutedShares: 15_000_000,
    latestQuarterEnd: "2026-06-30", latestQuarterFiledAt: "2026-08-01", latestQuarterEps: 4,
    sourceIds: ["financials"],
  };
  const prior: ReportedPeriod = { ...current, periodStart: "2024-07-01", periodEnd: "2025-06-30",
    filedAt: "2025-08-01", revenue: 1_000_000_000, netIncome: 180_000_000,
    operatingIncome: 200_000_000, operatingCashFlow: 220_000_000, capex: 60_000_000,
    dilutedShares: 16_000_000, latestQuarterEnd: "2025-06-30", latestQuarterFiledAt: "2025-08-01" };
  value.rule = SEC_SCENARIO_RULE;
  value.method = "Reported earnings scenario P/E";
  value.input.earningsBasis = "gaap-derived-scenario";
  value.input.estimates = [];
  value.input.peers = [];
  value.input.scenario = { current, prior, peers: [] };
  value.peers = [{ symbol: "PEERA", reportedEps: 8.25, pe: 15 },
    { symbol: "PEERB", reportedEps: 9.5, pe: 20 }, { symbol: "PEERC", reportedEps: 10.75, pe: 25 }];
  value.scenarioAssumptions = { baseRevenue: current.revenue, dilutedShares: current.dilutedShares,
    observedRevenueGrowth: .2, revenueGrowth: { bear: -.05, base: .1, bull: .2 },
    netMargin: { bear: .15, base: .2, bull: .22 } };
  value.assumptions = ["情景参数未经实证校准。"];
  for (const horizon of [value.sixMonth, value.twelveMonth]) {
    horizon.earningsStart = addMonths(horizon.targetDate, -12);
    horizon.earningsEnd = horizon.targetDate;
  }
  return { symbol: value.symbol, state, history: [value], atEntry: null, entryAt: null, error: null };
}

const render = (data: FundamentalPageData) => renderToStaticMarkup(createElement(FundamentalPanel, { data }));

describe("reported financial scenario readout", () => {
  it("describes saved financial assumptions instead of inventing analyst forecasts", () => {
    const value = scenarioPage().state!.current!, readout = formulaReadout(value, "not-requested");
    expect(confidenceReadout(value)).toBe("低 · V2 预设");
    expect(readout.summary).toContain("目标时点年化盈利能力情景");
    expect(readout.summary).toContain("3 家有效同业的财报口径 P/E");
    expect(readout.dependencies.join(" ")).toContain("固定稀释股数");
    expect(readout.uncertainties.join(" ")).toContain("不是逐季度盈利或未来现金流预测");
    expect(readout.uncertainties.join(" ")).toContain("尚未经过实证概率校准");
    expect(JSON.stringify(readout)).not.toMatch(/Non-GAAP|Forward P\/E|目标日期之后 12 个月|分析师/);
  });

  it("labels the new horizon, earnings and peer basis while preserving the saved numbers", () => {
    const data = scenarioPage(), original = structuredClone(data), html = render(data);
    expect(html).toContain("目标时点年化盈利能力情景 · 参考窗口");
    expect(html).toContain("2026-04-04 至 2027-04-04");
    expect(html).toContain("2026-10-04 至 2027-10-04");
    expect(html).toContain("不代表该时段实际盈利或未来现金流预测");
    expect(html).toContain("Reported earnings scenario P/E");
    expect(html).toContain("情景年化每股盈利");
    expect(html).toContain("财报口径每股盈利");
    expect(html).toContain("$8.25");
    expect(html).toContain("不是财报直接披露的 EPS");
    expect(html).toContain("低 · V2 预设");
    expect(html).toContain("不是统计计算的置信水平");
    expect(html).toContain("不是实证概率");
    expect(html).not.toMatch(/Non-GAAP|Forward P\/E|未来 12 个月 EPS|目标日期之后 12 个月/);
    expect(data).toEqual(original);
  });

  it("keeps factual baselines and growth/margin assumptions in accessible folded tables", () => {
    const html = render(scenarioPage()), detailStart = html.indexOf("<details");
    const detail = html.slice(detailStart, html.indexOf("</details>", detailStart));
    expect(html.slice(0, detailStart)).not.toContain("已披露财报基线");
    for (const text of ["已披露财报基线", "本期 TTM", "上一期 TTM", "$1,200,000,000.00", "$1,000,000,000.00",
      "净利率", "20.0%", "18.0%", "自由现金流 · CFO − CapEx", "$230,000,000.00", "$160,000,000.00",
      "最近季度稀释加权股数 · 股", "15,000,000", "16,000,000", "自建情景参数 · 模型假设",
      "年化收入增长率", "-5.0%", "+10.0%", "+20.0%", "15.0%", "22.0%", "情景固定稀释股数"]) {
      expect(detail).toContain(text);
    }
    expect(html).toContain('<caption>已披露财报基线 · USD</caption>');
    expect(html).toContain('<th scope="row">收入</th>');
    expect(html).toContain("不是公司指引或外部一致预期");
    expect(html).toContain("基准 TTM 收入 × (1 + 情景增长率)^(月数 / 12)");
    expect(html).toContain('aria-label="来源 1：financials"');
  });

  it("preserves a historical consensus model's own labels beside the new current model", () => {
    const data = scenarioPage();
    data.state!.current!.publishedAt = "2026-10-05T12:00:00.000Z";
    data.atEntry = fundamentalStateFixture().current;
    data.entryAt = "2026-10-04T13:00:00.000Z";
    const html = render(data), historicalStart = html.indexOf('id="entry-valuation"');
    expect(html.slice(0, historicalStart)).toContain("目标时点年化盈利能力情景");
    expect(html.slice(0, historicalStart)).not.toContain("Non-GAAP");
    expect(html.slice(historicalStart)).toContain("Non-GAAP 分析师共识 EPS");
    expect(html.slice(historicalStart)).toContain("Forward P/E");
    expect(html.slice(historicalStart)).toContain("盈利窗口 2027-04-04 至 2028-04-04");
    expect(html.slice(historicalStart)).toContain("低 · V1 预设");
    expect(html).toContain("不使用当前报价回填");
  });

  it("attributes a model switch to the method change without displaying earnings revision contributions", () => {
    const data = scenarioPage();
    data.state!.current!.revision = { previousId: "previous", previousTarget: 100, newTarget: 120,
      changePct: 20, earningsContribution: 0, multipleContribution: 0, kind: "model-change", modelContribution: 20 };
    const html = render(data);
    expect(html).toContain("原目标 $100.00 → 新目标 $120.00");
    expect(html).toContain("模型口径变更贡献 $20.00");
    expect(html).toContain("两版方法不同，不解读为盈利预期修订");
    expect(html).not.toContain("盈利变化贡献");
    expect(html).not.toContain("倍数变化贡献");
  });
});
