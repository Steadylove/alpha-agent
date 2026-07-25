import {
  medalForRank,
  positionCapPercent,
  sectorMomentumLabel,
  signalLabel,
  signedPercent,
  starsFromScore,
  watchlistStatusLabel,
} from "@/lib/scoring/format";
import type { DailyReport, DailyReportInput, ExecutionPlan, StockScore } from "@/lib/types/market";

const REPORT_VERSION = "System V6.1";

const regimeMeta = (mss: number) => {
  if (mss >= 75) return { label: "Risk-On", nuance: "结构性上涨", icon: "🟢" };
  if (mss >= 50) return { label: "Neutral", nuance: "结构分化", icon: "🟡" };
  return { label: "Risk-Off", nuance: "避险主导", icon: "🔴" };
};

const factorLabel = (score: number | null, thresholds: { good: number; ok: number }) => {
  if (score == null) return "缺失";
  if (score >= thresholds.good) return "健康";
  if (score >= thresholds.ok) return "分化";
  return "警戒";
};

export function renderDailyReport(input: DailyReportInput): DailyReport {
  const topSectors = input.sectorScores.slice(0, 3);
  const top5Score = input.stockScores.slice(0, 5);
  const insights = input.insights;
  const executions = input.executions ?? (input.execution ? [input.execution] : []);
  const executionBySymbol = new Map<string, ExecutionPlan>(
    executions.map((plan) => [plan.symbol, plan]),
  );
  const featured = input.execution ?? executions[0] ?? null;
  const featuredStock = featured
    ? top5Score.find((stock) => stock.symbol === featured.symbol) ?? top5Score[0]
    : top5Score[0];
  const regime = regimeMeta(input.marketMetric.mss);

  // Alpha Universe: 按 R:R 降序重排；无 execution 的排到最后（按 Final Score 兜底）
  const displayTop5 = top5Score
    .map((stock) => ({ stock, plan: executionBySymbol.get(stock.symbol) ?? null }))
    .sort((a, b) => {
      const rrA = a.plan ? a.plan.rewardRiskRatio : -Infinity;
      const rrB = b.plan ? b.plan.rewardRiskRatio : -Infinity;
      if (rrA !== rrB) return rrB - rrA;
      return b.stock.finalCompassScore - a.stock.finalCompassScore;
    });

  const title = `Market Compass 6.1 每日投资罗盘 ${input.date}`;
  const summary = `${regime.label} | MSS ${input.marketMetric.mss}/100 | Top: ${displayTop5
    .map((item) => item.stock.symbol)
    .join(", ")}`;

  const bodyParts: string[] = [];
  const push = (...lines: (string | null)[]) => {
    for (const line of lines) if (line !== null) bodyParts.push(line);
  };

  // Header
  push(
    `# ${title}`,
    "",
    `报告日期：${input.date} | 版本：${REPORT_VERSION} | 引擎：Unified Scoring Engine | 交易定位：中短线波段（2周 - 2个月）`,
    "",
  );

  // 一、Market Regime — 因子命名严格对齐白皮书：流动性/风险偏好/市场宽度/尾部风险
  const skew = input.marketMetric.skewScore;
  const pcr = input.marketMetric.pcrScore;
  const credit = input.marketMetric.creditScore;
  const breadth = input.marketMetric.breadthScore;
  push(
    "## 一、🌎 Market Regime 全球市场状态扫描",
    "",
    `- 宏观安全得分 (Market Score)：**${input.marketMetric.mss} / 100** ${regime.icon} (${regime.label} ${regime.nuance})`,
    `- 因子状态：流动性 ${credit ?? "N/A"}/25 (${factorLabel(credit, { good: 20, ok: 10 })}) | 风险偏好 ${pcr ?? "N/A"}/25 (${factorLabel(pcr, { good: 20, ok: 10 })}) | 市场宽度 ${breadth ?? "N/A"}/25 (${factorLabel(breadth, { good: 20, ok: 12 })}) | 尾部风险 ${skew ?? "N/A"}/25 (${factorLabel(skew, { good: 20, ok: 12 })})`,
    `- 数据置信度：${Math.round(input.marketMetric.confidence * 100)}%`,
    insights?.marketNarrative ? `> 💡 **AI 市场解读**：${insights.marketNarrative}` : null,
    "",
  );

  // 二、Market Catalyst
  push(
    "## 二、📰 Market Catalyst 今日驱动因素",
    "",
    insights?.themeChain && insights.themeChain.length > 0
      ? `- 🚀 **核心逻辑链**：${insights.themeChain.join(" ➔ ")}`
      : null,
    insights?.beneficiarySectors && insights.beneficiarySectors.length > 0
      ? `- 🟢 **核心受益方向**：${insights.beneficiarySectors.join(" | ")}`
      : null,
    "",
  );
  if (input.newsItems.length > 0) {
    input.newsItems.slice(0, 5).forEach((item, index) => {
      const symbols = item.relatedSymbols.length > 0 ? ` | 相关：${item.relatedSymbols.slice(0, 6).join(", ")}` : "";
      push(`${index + 1}. [${item.headline}](${item.url})${symbols}`);
    });
  } else {
    push("- 暂无新闻数据。");
  }
  push("");

  // 三、Sector Compass — 白皮书示范每行带 "➔ 主线定语"
  push("## 三、🔄 Sector Compass 行业资金罗盘 (Top 3)", "");
  topSectors.forEach((sector) => {
    const headline = insights?.sectorHeadlines?.[sector.name];
    const suffix = headline ? ` ➔ ${headline}` : "";
    push(
      `${medalForRank(sector.rank)} **${sector.name}** (Sector Score: **${sector.score}** | ${sectorMomentumLabel(sector)})${suffix}`,
    );
  });
  push("");

  // 四、Alpha Universe — 按 R:R 排序，Top 5 全部标 60D 预期 + R:R
  push(
    "## 四、🚀 Alpha Universe 强势股票池 (Top 5 综合排序)",
    "",
    executions.length > 0 ? "（按 Reward/Risk 预期盈亏比统一排序）" : "",
  );
  displayTop5.forEach((item, index) => {
    const { stock, plan } = item;
    const suffix = plan
      ? ` ➔ 60D 交易目标价: $${plan.valuation.weightedFair.toFixed(2)} | 预期盈亏比: ${plan.rewardRiskRatio.toFixed(2)}`
      : "";
    push(
      `${index + 1}. **${stock.symbol}** (Final Compass Score: **${stock.finalCompassScore}** | ${starsFromScore(stock.finalCompassScore)})${suffix}`,
    );
  });
  push("");

  // 五、Investment Card（v3 三块结构：质量卡 / PWFV / Trading Target）
  const cardTitle = featuredStock
    ? `## 五、⭐ Investment Card 个股深度研究卡 (${featuredStock.symbol})`
    : "## 五、⭐ Investment Card 个股深度研究卡";
  push(cardTitle, "");
  if (featuredStock) {
    const killLabel = featuredStock.killSwitchStatus === "PASSED"
      ? "PASSED 🟢"
      : `BLOCKED ⛔（${featuredStock.killSwitchReason ?? "-"}）`;
    push(
      `- **标的**：${featuredStock.name} (${featuredStock.symbol}) | Final Compass **${featuredStock.finalCompassScore}/100** | 熔断 ${killLabel}`,
      "",
    );

    // 5.1 五维公司质量卡
    push("### 5.1 · 五维公司质量卡（Stock Quality 50 分）");
    const d = featuredStock.details;
    push(
      `- **Momentum ${featuredStock.momentumScore}/15**：加权 RPS=${d.weightedRps ?? "N/A"} · 加速度=${d.acceleration ?? "N/A"} · Event Ratio=${typeof d.eventRatio === "number" ? d.eventRatio.toFixed(2) : "N/A"}`,
      `- **Trend ${featuredStock.trendScore}/10**：${d.stackedMa ? "均线多头 ✅" : "均线未排列 ❌"} · 距 52 周高=${typeof d.proximityToHigh === "number" ? signedPercent(d.proximityToHigh) : "N/A"} · Up Day 63D=${typeof d.upDayRatio63 === "number" ? signedPercent(d.upDayRatio63).replace("+", "") : "N/A"}`,
      `- **Fundamental ${featuredStock.fundamentalScore}/25**：Growth=${d.growthScore ?? 0}/8 · Profit=${d.profitScore ?? 0}/7 · Revisions=${d.revisionScore ?? 0}/5 · Moat=${d.moatScore ?? 0}/5${d.moatSource === "llm" ? " (LLM)" : " (兜底)"}${d.fundamentalVetoed ? " ⛔ EPS Revision 一票否决" : ""}`,
    );
    if (typeof d.moatReason === "string" && d.moatReason) {
      push(`- 🧠 **LLM 护城河判读**：${d.moatReason}`);
    }
    const quality = insights?.featuredQuality;
    if (quality) push(`- 💡 **AI 主题定位**：${quality}`);
    push("");

    // 5.2 6-12M PWFV 概率加权公允价
    push("### 5.2 · 6-12M PWFV 概率加权公允价（Valuation MoS 10 分）");
    if (featured) {
      const v = featured.valuation;
      const src = d.pwfvSource === "analyst-consensus" ? "分析师共识" : "动量兜底";
      push(
        `- 🐻 Bear: \`$${v.bear.toFixed(2)}\` | ⚖ Base: \`$${v.base.toFixed(2)}\` (${src}) | 🚀 Bull: \`$${v.bull.toFixed(2)}\``,
        `- **加权公允价**: **\`$${v.weightedFair.toFixed(2)}\`** · 安全边际 **${signedPercent(v.safetyMargin)}** · MoS 得分 ${d.pwfvScore ?? 0}/10`,
      );
    } else {
      push("- PWFV 数据不足，暂缓输出。");
    }
    push("");

    // 5.3 60D 波段交易目标价（Trading Target）
    push("### 5.3 · 60D 波段交易目标价（Valuation RRR 10 分）");
    if (typeof d.tradingTarget60d === "number" && typeof d.tradingStopLoss === "number") {
      push(
        `- 🎯 **60D Target**: **\`$${d.tradingTarget60d.toFixed(2)}\`** = min(60D 阻力位, 当前价 + 1.5×ATR14×√60)`,
        `- 🔴 **动态止损**: \`$${d.tradingStopLoss.toFixed(2)}\` = 当前价 − 2×ATR14`,
        `- **R:R 盈亏比**: **${typeof d.rewardRiskRatio === "number" ? d.rewardRiskRatio.toFixed(2) : "N/A"}** · RRR 得分 ${d.rrrScore ?? 0}/10`,
      );
    } else {
      push("- Trading Target 数据不足（ATR14 或 60D 阻力位缺失）。");
    }
    push("");
    push(
      "> 💡 **Dual-Target 双价格解耦**：PWFV 是长期公允价（是否值得持有），Trading Target 是 60D 波段目标（下一段行情空间）。两者独立评估，不混用。",
    );
  } else {
    push("- 暂无符合条件的 Top 5 标的。");
  }
  push("");

  // 六、Execution Compass
  if (featured) {
    renderExecutionSection(push, featured, featuredStock);
  }

  // 七、Portfolio Monitor — 严格 4 列：股票 | 昨日状态 | 今日变化 | Final Score
  push(
    "## 七、📌 Portfolio Monitor 股票状态追踪",
    "",
    "| 股票 | 昨日状态 | 今日变化 | Final Score |",
    "| :--- | :--- | :--- | :--- |",
  );
  input.watchlistChanges.forEach((change) => {
    const prevLabel = change.previous ? watchlistStatusLabel(change.previous) : "无";
    const currLabel = watchlistStatusLabel(change.current);
    const delta = change.previous === change.current ? change.reason : `${currLabel}（${change.reason}）`;
    const score = change.finalScore != null ? change.finalScore.toString() : "-";
    push(`| **${change.symbol}** | ${prevLabel} | ${delta} | ${score} |`);
  });
  push("");

  // 八、Philosophy
  push(
    "## 八、💡 Market Compass 投资哲学",
    "",
    "市场环境 ➔ 资金方向 ➔ 强势资产 ➔ 公司价值 ➔ 合理价格 ➔ 执行纪律",
    "",
    "---",
    "",
    "免责声明：本工具仅供量化数据及估值模型教学演示，不构成任何投资建议。",
  );

  return {
    date: input.date,
    title,
    summary,
    body: bodyParts.join("\n"),
    version: REPORT_VERSION,
  };
}

function renderExecutionSection(
  push: (...lines: (string | null)[]) => void,
  plan: ExecutionPlan,
  featuredStock: StockScore | undefined,
) {
  const positionCap = positionCapPercent(plan.signalConfidence, plan.rewardRiskRatio);
  const costPrice = plan.currentPrice;
  const nameSuffix = featuredStock ? ` (${plan.symbol} - ${featuredStock.name})` : ` (${plan.symbol})`;

  push(
    "## 六、🎯 Execution Compass 个股买卖执行计划",
    "",
    `[🟢 主线波段趋势轨${nameSuffix}]`,
    `- **信号置信度**：${plan.signalConfidence} ${starsFromScore(plan.signalConfidence)} (${signalLabel(plan.signalConfidence)}，动态仓位上限：**${positionCap.toFixed(1)}%**)`,
    `- **60D 期望评估**：预期收益 ${signedPercent(plan.expectedReturn60d)} | 预期波动 ${(plan.expectedVolatility60d * 100).toFixed(1)}% | 预期盈亏比 (Reward/Risk): **${plan.rewardRiskRatio.toFixed(2)}**`,
    `- **算法黄金低吸带 (Golden Buy Zone)**：\`$${plan.goldenBuyLow.toFixed(2)} - $${plan.goldenBuyHigh.toFixed(2)}\` (基于 SMA20 / SMA50 / TWAP20 多重支撑重心)`,
    "",
    "**三阶梯动态建仓战法**",
    `- 🧪 第一阶段（试探仓 20%）：突破关键阻力位且资金确认分通过时建立试探仓；`,
    `- 🟢 第二阶段（黄金低吸 50% 核心仓）：股价缩量回踩 Golden Buy Zone 企稳时按 **${positionCap.toFixed(1)}%** 动态仓位重点建仓；`,
    `- 🚀 第三阶段（趋势追加 30%）：突破前高并连续 2 日站稳后追加。`,
    "",
    "**硬核止损与移动止盈**",
    `- 🔴 **动态止损**：\`$${plan.stopLoss.toFixed(2)}\` (基于 2×ATR14，跌破无条件离场)；`,
    `- 🔵 **移动止盈**：达公允价 \`$${plan.valuation.weightedFair.toFixed(2)}\` 减仓 1/3 并提止损至成本价 \`$${costPrice.toFixed(2)}\`；剩余仓位破 EMA20 全清。`,
    "",
  );
}
