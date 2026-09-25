import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnalystNote } from "@/components/review/AnalystNote";
import type { AnalysisReport, AnalysisView } from "@/lib/review/analysis/types";

function report(): AnalysisReport {
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

const render = (analysis: AnalysisView) => renderToStaticMarkup(createElement(AnalystNote, { analysis }));

describe("saved review analysis display", () => {
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
});
