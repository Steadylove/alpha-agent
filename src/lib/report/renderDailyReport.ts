import type { DailyReport, DailyReportInput } from "@/lib/types/market";

const statusLabel = (mss: number) => {
  if (mss >= 75) return "Risk-On";
  if (mss >= 50) return "Neutral";
  return "Risk-Off";
};

export function renderDailyReport(input: DailyReportInput): DailyReport {
  const topSectors = input.sectorScores.slice(0, 3);
  const topStocks = input.stockScores.slice(0, 5);
  const featured = topStocks[0];
  const insights = input.insights;
  const title = `Market Compass 每日投资罗盘 ${input.date}`;
  const summary = `${statusLabel(input.marketMetric.mss)} | MSS ${input.marketMetric.mss}/100 | Top: ${topStocks
    .map((stock) => stock.symbol)
    .join(", ")}`;

  const body = [
    `# ${title}`,
    "",
    `报告日期：${input.date} | 版本：Daily Report V1.0 | 交易定位：中短线波段（2周 - 2个月）`,
    "",
    "## 一、Market Regime 全球市场状态扫描",
    "",
    `- 当前市场状态：${statusLabel(input.marketMetric.mss)} | Market Safety Score：${input.marketMetric.mss} / 100`,
    `- 数据置信度：${Math.round(input.marketMetric.confidence * 100)}%`,
    `- 信用利差代理：${input.marketMetric.creditScore ?? "数据缺失"} / 25`,
    `- 市场宽度：${input.marketMetric.breadthScore ?? "数据缺失"} / 25`,
    ...(insights?.marketNarrative
      ? ["", `> 💡 **AI 市场解读**：${insights.marketNarrative}`]
      : []),
    "",
    "## 二、Market Catalyst 今日新闻催化",
    "",
    ...(insights?.themeChain && insights.themeChain.length > 0
      ? [`- 🚀 **核心逻辑链**：${insights.themeChain.join(" ➔ ")}`]
      : []),
    ...(insights?.beneficiarySectors && insights.beneficiarySectors.length > 0
      ? [`- 🟢 **核心受益方向**：${insights.beneficiarySectors.join(" | ")}`, ""]
      : [""]),
    ...(input.newsItems.length > 0
      ? input.newsItems.slice(0, 5).map((item, index) => {
          const symbols = item.relatedSymbols.length > 0 ? ` | 相关：${item.relatedSymbols.join(", ")}` : "";
          return `${index + 1}. ${item.headline}${symbols}\n   ${item.url}`;
        })
      : ["- 暂无新闻数据。"]),
    "",
    "## 三、Sector Compass 行业资金罗盘 Top 3",
    "",
    ...topSectors.map(
      (sector) =>
        `${sector.rank}. ${sector.name} (${sector.symbol}) | Score: ${sector.score} | 21D RS: ${(sector.rs21 * 100).toFixed(
          2,
        )}% | 63D RS: ${(sector.rs63 * 100).toFixed(2)}%`,
    ),
    "",
    "## 四、Alpha Universe 强势股票池 Top 5",
    "",
    ...topStocks.map(
      (stock) =>
        `${stock.rank}. ${stock.symbol} (${stock.name}) | 评分: ${stock.totalScore}/100 | 状态: ${stock.status}`,
    ),
    "",
    featured ? `## 五、Investment Card 个股深度研究卡 (${featured.symbol})` : "## 五、Investment Card 个股深度研究卡",
    "",
    featured
      ? `- 综合评分：${featured.totalScore}/100\n- Momentum：${featured.rpsScore}/25 | Trend：${featured.trendScore}/20 | Sector：${featured.sectorScore}/15 | Fundamental：${featured.fundamentalScore}/25 | Accumulation：${featured.accumulationScore}/15\n- 核心判断：当前进入 Top 5 跟踪池，等待估值模型与买点确认后再输出执行建议。`
      : "- 暂无符合条件的 Top 5 标的。",
    "",
    "## 六、Portfolio Monitor 股票状态追踪",
    "",
    "| 股票 | 昨日状态 | 今日状态 | 变化说明 |",
    "| :--- | :--- | :--- | :--- |",
    ...input.watchlistChanges.map(
      (change) => `| ${change.symbol} | ${change.previous ?? "无"} | ${change.current} | ${change.reason} |`,
    ),
    "",
    "## Market Compass 投资哲学",
    "",
    "市场环境 -> 资金方向 -> 强势资产 -> 公司价值 -> 合理价格 -> 执行纪律",
    "",
    "免责声明：本工具仅供量化数据及估值模型教学演示，不构成任何投资建议。",
  ].join("\n");

  return {
    date: input.date,
    title,
    summary,
    body,
    version: "Daily Report V1.0",
  };
}
