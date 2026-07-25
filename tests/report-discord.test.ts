import { chunkDiscordMessage, renderDailyReportDiscordPayload } from "@/lib/discord/sendWebhook";
import { demoReport, demoReportInput } from "@/lib/fixtures/demo";
import { renderDailyReport } from "@/lib/report/renderDailyReport";
import { describe, expect, it } from "vitest";

describe("report and discord", () => {
  it("renders the daily report with disclaimer", () => {
    const report = renderDailyReport(demoReportInput);

    expect(report.title).toContain("Market Compass");
    expect(report.body).toContain("免责声明");
    expect(report.summary).toContain("MSS");
  });

  it("chunks long Discord messages below limit", () => {
    const chunks = chunkDiscordMessage("a".repeat(5000), 1900);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1900)).toBe(true);
  });

  it("provides a complete demo report for UI fallback", () => {
    expect(demoReport.body).toContain("Alpha Universe");
    expect(demoReportInput.stockScores[0].symbol).toBe("NVDA");
  });

  it("renders a structured Discord embed for daily reports", () => {
    const payload = renderDailyReportDiscordPayload(demoReportInput, demoReport);

    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds?.[0].title).toBe("🟢 Market Compass 6.1 每日简报");
    expect(payload.embeds?.[0].fields?.map((field) => field.name)).toEqual([
      "📊 市场状态",
      "🔄 行业资金罗盘 Top 3",
      "📰 今日新闻催化",
      "🚀 强势股票池 Top 5（按 R:R 排序）",
      "⭐ Investment Card 深度研究卡",
      "🎯 Execution Compass (NVDA)",
      "📌 Portfolio Monitor 状态追踪",
      "🟢 数据质量",
    ]);
    expect(payload.embeds?.[0].fields?.[0].value).toContain("流动性");
    expect(payload.embeds?.[0].fields?.[1].value).toContain("🥇");
    expect(payload.embeds?.[0].fields?.[1].value).toContain("第一主线");
    expect(payload.embeds?.[0].fields?.[2].value).toContain("AI infrastructure");
    expect(payload.embeds?.[0].fields?.[2].value).toContain("](https://example.com");
    expect(payload.embeds?.[0].fields?.[3].value).toContain("R:R");
    expect(payload.embeds?.[0].fields?.[4].value).toContain("PWFV");
    expect(payload.embeds?.[0].fields?.[4].value).toContain("CUDA");
    expect(payload.embeds?.[0].fields?.[5].value).toContain("Golden Buy Zone");
    expect(payload.embeds?.[0].fields?.[5].value).toContain("单次进场");
    expect(payload.embeds?.[0].fields?.[5].value).toContain("成本价");
    expect(payload.embeds?.[0].fields?.[6].value).toContain("Final");
  });
});
