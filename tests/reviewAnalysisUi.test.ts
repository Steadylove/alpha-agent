import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalystNote } from "@/components/review/AnalystNote";
import type { AnalysisReport, AnalysisView, LegacyAnalysisOutput, MarketIntelligenceOutput } from "@/lib/review/analysis/types";

function report(): AnalysisReport & { output: LegacyAnalysisOutput } {
  return {
    version: "daily-analyst-v1",
    date: "2026-09-24",
    generatedAt: "2026-09-25T04:30:00.000Z",
    sourceBuiltAt: "2026-09-24T21:00:00.000Z",
    sourceHash: "source-hash",
    inputHash: "input-hash",
    promptVersion: "test",
    model: "deepseek-v4-pro",
    usage: null,
    evidence: {
      version: "analyst-evidence-v1",
      date: "2026-09-24",
      sourceBuiltAt: "2026-09-24T21:00:00.000Z",
      states: { market: "Neutral", legacy: "Transition", macro: "Mixed" },
      coverage: [
        { section: "market", status: "available", issues: [] },
        { section: "options", status: "partial", issues: ["SPX 当日快照缺失"] },
      ],
      facts: [
        {
          id: "market.breadth",
          section: "market",
          label: "上涨比例",
          value: 49.2,
          unit: "%",
          asOf: "2026-09-24",
          basis: "当日留档",
          status: "current",
          source: "股票池价格",
          groups: ["market-price"],
          note: "市场体温与广度是同一项数据。",
        },
        {
          id: "unused.fact",
          section: "market",
          label: "不应展示的未引用事实",
          value: null,
          unit: "",
          asOf: null,
          basis: "",
          status: "missing",
          source: "test",
          groups: [],
        },
      ],
    },
    output: {
      lead: { text: "市场状态为 Neutral，上涨参与度接近一半。", factIds: ["market.breadth"] },
      changes: [],
      divergences: [],
      confirmations: [],
      context: [],
      focus: [],
      limitations: [],
    },
  };
}

function intelligenceReport(): AnalysisReport & { output: MarketIntelligenceOutput } {
  const legacy = report();
  const claim = (text: string) => ({ text, factIds: ["market.breadth"] });
  return {
    ...legacy,
    output: {
      format: "market-intelligence-v2",
      marketRead: claim("市场解读：上涨参与度接近一半，尚不能确认全面扩散。"),
      evidenceMap: [claim("证据关系：参与度与指数表现需要交叉验证。")],
      structureRead: claim("市场结构：留档广度不足以独立判断趋势状态。"),
      systemRead: [claim("系统表现：缺少已成熟的同类样本，无法判断适应性。")],
      eventFlowContext: [claim("辅助观察：缺少可核对的事件与成交流记录，无法判断。")],
      synthesis: claim("综合解读：现有证据只支持局部观察。"),
      validationPoints: [claim("待验证事实：下一交易日上涨参与度是否扩大。")],
    },
  };
}

const render = (analysis: AnalysisView) => renderToStaticMarkup(createElement(AnalystNote, { analysis }));
const analystStyles = readFileSync(new URL("../src/components/review/analyst.module.css", import.meta.url), "utf8");

describe("saved review analysis display", () => {
  it("presents all seven intelligence sections in reading order with expandable citations", () => {
    const html = render({ report: intelligenceReport(), status: "ready" });
    const headings = [...html.matchAll(/<h3 id="analysis-([A-G])">(.*?)<\/h3>/g)]
      .map((match) => [match[1], match[2].replace(/<[^>]*>/g, "")]);
    expect(headings).toEqual([
      ["A", "A Market Read 市场解读"],
      ["B", "B Evidence Map 证据关系"],
      ["C", "C Structure Read 市场结构"],
      ["D", "D System Read 系统表现"],
      ["E", "E Event × Flow Context 辅助观察"],
      ["F", "F AI Synthesis 综合解读"],
      ["G", "G Validation Points 待验证事实"],
    ]);
    expect(html.match(/<section /g)).toHaveLength(7);
    expect(html.match(/查看依据 · 1 项/g)).toHaveLength(7);
    expect(html).toContain('aria-labelledby="analysis-A"');
    expect(html).toContain('href="#market"');
    expect(html).not.toContain("不应展示的未引用事实");
    expect(html).not.toContain("值得留意的变化");
  });

  it("keeps the intelligence reading layout single-column on narrow screens", () => {
    const html = render({ report: intelligenceReport(), status: "ready" });
    expect(html).not.toContain("<table");
    expect(analystStyles).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*?\.intelligence \.group\s*\{[^}]*grid-template-columns:\s*1fr;/);
    expect(analystStyles).toMatch(/\.sectionBody\s*\{[^}]*min-width:\s*0;/);
    expect(analystStyles).toContain("overflow-wrap: anywhere");
  });

  it("keeps empty intelligence sections visible without inventing an interpretation", () => {
    const saved = intelligenceReport();
    saved.output.evidenceMap = [];
    saved.output.systemRead = [];
    saved.output.eventFlowContext = [];
    saved.output.validationPoints = [];
    const html = render({ report: saved, status: "ready" });
    expect(html.match(/<section /g)).toHaveLength(7);
    expect(html.match(/本节暂无可用解读，无法判断。/g)).toHaveLength(4);
    expect(html).toContain("市场结构：留档广度不足以独立判断趋势状态。");
  });

  it("labels optional Event × Flow evidence as auxiliary context and uses its existing anchor", () => {
    const saved = intelligenceReport();
    saved.evidence.coverage.push({ section: "context", status: "partial", issues: ["部分市场样本"] });
    saved.evidence.facts.push({
      id: "context.observation",
      section: "context",
      label: "观察范围",
      value: "部分市场样本",
      unit: "",
      asOf: "2026-09-24",
      basis: "事件与成交流留档",
      status: "current",
      source: "Context",
      groups: ["auxiliary-context"],
    });
    saved.output.eventFlowContext = [{ text: "事件与成交仅作为辅助线索。", factIds: ["context.observation", "context.observation"] }];
    const html = render({ report: saved, status: "ready" });
    expect(html).toContain('href="#catalyst-today">Event × Flow · 辅助观察');
    expect(html).not.toContain('href="#context"');
    expect(html.match(/观察范围/g)).toHaveLength(1);
    expect(html).toContain("部分市场样本");
  });

  it("presents archived claims with expandable source facts and their original section", () => {
    const html = render({ report: report(), status: "ready" });
    expect(html).toContain("市场状态为 Neutral，上涨参与度接近一半。");
    expect(html).toContain("查看依据 · 1 项");
    expect(html).toContain('href="#market"');
    expect(html).toContain("49.2 %");
    expect(html).toContain("市场体温与广度是同一项数据。");
    expect(html).not.toContain("不应展示的未引用事实");
    expect(html).not.toContain("下一交易日，继续观察");
  });

  it("keeps data coverage distinct from market and macro labels", () => {
    const html = render({ report: report(), status: "ready" });
    expect(html).toContain("原始市场状态</dt><dd>Neutral");
    expect(html).toContain("宏观环境</dt><dd>Mixed");
    expect(html).toContain("输入完整性</dt><dd>部分数据可用");
    expect(html).toContain("SPX 当日快照缺失");
    expect(html).toContain("Transition（与市场状态字段分别保留）");
  });

  it("labels stale output prominently and shows the actual later generation time", () => {
    const html = render({ report: report(), status: "stale" });
    expect(html).toContain("旧版留档");
    expect(html).toContain("复盘数据已在这份分析生成后更新");
    expect(html).toContain("2026/09/25 00:30 ET");
    expect(html).toContain("历史解读不代表当时已发布的判断");
  });

  it("uses independent empty states without presenting unavailable content as current", () => {
    const missing = render({ report: null, status: "missing" });
    expect(missing).toContain("等待该交易日复盘生成后的自动分析");
    expect(missing).toContain("刷新页面不会重新调用模型");
    const unavailable = render({ report: report(), status: "unavailable" });
    expect(unavailable).toContain("现有复盘仍可正常查看");
    expect(unavailable).not.toContain("上涨参与度接近一半");
  });

  it("renders model text and evidence as escaped text, never executable HTML", () => {
    const unsafe = report();
    unsafe.output.lead.text = '<script>alert("model")</script>';
    unsafe.evidence.facts[0].note = '<img src="x" onerror="alert(1)">';
    const html = render({ report: unsafe, status: "ready" });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("preserves stale and failure states for intelligence reports and escapes their text", () => {
    const saved = intelligenceReport();
    saved.output.synthesis.text = '<script>alert("model")</script>';
    const stale = render({ report: saved, status: "stale" });
    expect(stale).toContain("复盘数据已在这份分析生成后更新");
    expect(stale).toContain("AI Synthesis");
    expect(stale).not.toContain("<script>");
    expect(stale).toContain("&lt;script&gt;");
    const unavailable = render({ report: saved, status: "unavailable" });
    expect(unavailable).toContain("现有复盘仍可正常查看");
    expect(unavailable).not.toContain("AI Synthesis");
  });
});
