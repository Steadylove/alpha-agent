import {
  medalForRank,
  positionCapPercent,
  sectorMomentumLabel,
  signalLabel,
  signedPercent,
  starsFromScore,
  watchlistStatusLabel,
} from "@/lib/scoring/format";
import type { DailyReport, DailyReportInput } from "@/lib/types/market";
import { request } from "node:https";

const DISCORD_LIMIT = 1900;

type DiscordEmbed = {
  title: string;
  description?: string;
  color?: number;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  footer?: { text: string };
};

type DiscordPayload = {
  content?: string;
  embeds?: DiscordEmbed[];
};

export function chunkDiscordMessage(message: string, limit = DISCORD_LIMIT): string[] {
  if (message.length <= limit) {
    return [message];
  }

  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    const slice = remaining.slice(0, limit);
    const splitAt = slice.lastIndexOf("\n");
    const chunk = splitAt > 500 ? slice.slice(0, splitAt) : slice;
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length).trimStart();
  }

  return chunks;
}

export async function sendDiscordWebhook(input: {
  webhookUrl: string;
  content: string;
}): Promise<void> {
  const chunks = chunkDiscordMessage(input.content);

  for (const chunk of chunks) {
    const response = await fetch(input.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: chunk }),
    });

    if (!response.ok) {
      throw new Error(`Discord webhook failed: ${response.status}`);
    }
  }
}

async function postDiscordPayload(webhookUrl: string, payload: DiscordPayload): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          connection: "close",
        },
        body: JSON.stringify(payload),
        keepalive: false,
      });

      if (response.ok) {
        return;
      }

      lastError = new Error(`Discord webhook failed: ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }

  try {
    await postDiscordPayloadWithHttps(webhookUrl, payload);
    return;
  } catch (error) {
    lastError = error;
  }

  throw lastError instanceof Error ? lastError : new Error("Discord webhook failed.");
}

function postDiscordPayloadWithHttps(webhookUrl: string, payload: DiscordPayload): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const body = JSON.stringify(payload);
    const req = request(
      {
        method: "POST",
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
          return;
        }

        reject(new Error(`Discord webhook failed: ${res.statusCode}`));
      },
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const regimeLabelZh = (mss: number) => {
  if (mss >= 75) return "风险偏好";
  if (mss >= 50) return "中性震荡";
  return "风险规避";
};

const regimeColor = (mss: number) => {
  if (mss >= 75) return 0x22c55e;
  if (mss >= 50) return 0xf59e0b;
  return 0xef4444;
};

const regimeIcon = (mss: number) => {
  if (mss >= 75) return "🟢";
  if (mss >= 50) return "🟡";
  return "🔴";
};

const truncate = (value: string, maxLength: number) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

// Discord embed field.value 上限 1024 字符。所有 field 落地前统一截断，避免撞 400。
const DISCORD_FIELD_VALUE_LIMIT = 1024;
const fitField = (value: string) => truncate(value, DISCORD_FIELD_VALUE_LIMIT);

export function renderDailyReportDiscordPayload(
  input: DailyReportInput,
  report: DailyReport,
  errors: Record<string, string> = {},
): DiscordPayload {
  const executions = input.executions ?? (input.execution ? [input.execution] : []);
  const executionBySymbol = new Map(executions.map((plan) => [plan.symbol, plan]));
  const execution = input.execution ?? executions[0] ?? null;
  const top5Score = input.stockScores.slice(0, 5);
  const featured = execution
    ? top5Score.find((stock) => stock.symbol === execution.symbol) ?? top5Score[0]
    : top5Score[0];

  const displayTop5 = top5Score
    .map((stock) => ({ stock, plan: executionBySymbol.get(stock.symbol) ?? null }))
    .sort((a, b) => {
      const rrA = a.plan ? a.plan.rewardRiskRatio : -Infinity;
      const rrB = b.plan ? b.plan.rewardRiskRatio : -Infinity;
      if (rrA !== rrB) return rrB - rrA;
      return b.stock.finalCompassScore - a.stock.finalCompassScore;
    });

  const topSectors = input.sectorScores
    .slice(0, 3)
    .map((sector) => {
      const headline = input.insights?.sectorHeadlines?.[sector.name];
      const suffix = headline ? `\n   ➔ ${headline}` : "";
      return `${medalForRank(sector.rank)} **${sector.name}** · Sector Score **${sector.score}** · ${sectorMomentumLabel(sector)}${suffix}`;
    })
    .join("\n");

  const topStocks = displayTop5
    .map(({ stock, plan }, index) => {
      const head = `**${index + 1}. ${stock.symbol}** · Final **${stock.finalCompassScore}** ${starsFromScore(stock.finalCompassScore)}`;
      if (plan) {
        return `${head}\n   ➔ 60D 目标价 $${plan.valuation.weightedFair.toFixed(2)} · R:R **${plan.rewardRiskRatio.toFixed(2)}**`;
      }
      return head;
    })
    .join("\n");

  const changes = input.watchlistChanges
    .slice(0, 5)
    .map((change) => {
      const prevLabel = change.previous ? watchlistStatusLabel(change.previous) : "无";
      const currLabel = watchlistStatusLabel(change.current);
      const score = change.finalScore != null ? ` · Final **${change.finalScore}**` : "";
      const delta = change.previous === change.current ? change.reason : `${currLabel}（${change.reason}）`;
      return `**${change.symbol}**：${prevLabel} → ${delta}${score}`;
    })
    .join("\n");

  const news = input.newsItems
    .slice(0, 3)
    .map((item, index) => {
      const symbols = item.relatedSymbols.length > 0 ? item.relatedSymbols.slice(0, 6).join(",") : "-";
      return `${index + 1}. [${truncate(item.headline, 88)}](${item.url})\n   相关标的：\`${symbols}\``;
    })
    .join("\n\n");

  const errorSymbols = Object.keys(errors);
  const icon = regimeIcon(input.marketMetric.mss);
  const label = regimeLabelZh(input.marketMetric.mss);
  const insights = input.insights;

  const catalystValue = [
    insights?.themeChain && insights.themeChain.length > 0
      ? `**🚀 核心逻辑链**：${insights.themeChain.join(" ➔ ")}`
      : null,
    insights?.beneficiarySectors && insights.beneficiarySectors.length > 0
      ? `**🟢 核心受益方向**：${insights.beneficiarySectors.join(" | ")}`
      : null,
    news || null,
  ]
    .filter(Boolean)
    .join("\n\n") || "暂无新闻数据";

  const investmentCardValue = (() => {
    if (!featured) return "暂无符合条件的 Top 5 标的。";
    const killLabel =
      featured.killSwitchStatus === "PASSED"
        ? "熔断 PASSED 🟢"
        : `熔断 BLOCKED ⛔（${featured.killSwitchReason ?? "-"}）`;
    const d = featured.details;
    const lines = [
      `**${featured.name}** (\`${featured.symbol}\`) · Final Compass **${featured.finalCompassScore}/100** · ${killLabel}`,
      "",
      `**📊 五维质量卡 (${featured.qualityScore}/50)**`,
      `└─ Mom ${featured.momentumScore}/15 · Trend ${featured.trendScore}/10 · Fund ${featured.fundamentalScore}/25`,
      `└─ Moat ${d.moatScore ?? 0}/5 ${d.moatSource === "llm" ? "(LLM)" : "(兜底)"}`,
    ];
    if (typeof d.moatReason === "string" && d.moatReason) {
      lines.push(`🧠 ${d.moatReason}`);
    }
    if (insights?.featuredQuality) {
      lines.push(`💡 ${insights.featuredQuality}`);
    }
    if (execution) {
      const v = execution.valuation;
      const src = d.pwfvSource === "analyst-consensus" ? "分析师共识" : "动量兜底";
      lines.push(
        "",
        `**🎯 6-12M PWFV (MoS ${d.pwfvScore ?? 0}/10)**`,
        `🐻 \`$${v.bear.toFixed(2)}\` | ⚖ \`$${v.base.toFixed(2)}\` (${src}) | 🚀 \`$${v.bull.toFixed(2)}\``,
        `加权公允价 **$${v.weightedFair.toFixed(2)}** · 安全边际 **${signedPercent(v.safetyMargin)}**`,
      );
    }
    if (typeof d.tradingTarget60d === "number" && typeof d.tradingStopLoss === "number") {
      lines.push(
        "",
        `**⚡ 60D Trading Target (RRR ${d.rrrScore ?? 0}/10)**`,
        `🎯 \`$${d.tradingTarget60d.toFixed(2)}\` · 🔴 止损 \`$${d.tradingStopLoss.toFixed(2)}\` · R:R **${typeof d.rewardRiskRatio === "number" ? d.rewardRiskRatio.toFixed(2) : "N/A"}**`,
      );
    }
    return lines.join("\n");
  })();

  const fields: NonNullable<DiscordEmbed["fields"]> = [
    {
      name: "📊 市场状态",
      value: fitField(
        [
          `MSS：**${input.marketMetric.mss}/100**`,
          `流动性 ${input.marketMetric.creditScore ?? "N/A"}/25 · 风险偏好 ${input.marketMetric.pcrScore ?? "N/A"}/25 · 宽度 ${input.marketMetric.breadthScore ?? "N/A"}/25 · 尾部 ${input.marketMetric.skewScore ?? "N/A"}/25`,
          `置信度：${Math.round(input.marketMetric.confidence * 100)}%`,
        ].join("\n"),
      ),
      inline: false,
    },
    {
      name: "🔄 行业资金罗盘 Top 3",
      value: fitField(topSectors || "暂无行业评分"),
      inline: false,
    },
    {
      name: "📰 今日新闻催化",
      value: fitField(catalystValue),
      inline: false,
    },
    {
      name: "🚀 强势股票池 Top 5（按 R:R 排序）",
      value: fitField(topStocks || "暂无股票评分"),
      inline: false,
    },
    {
      name: "⭐ Investment Card 深度研究卡",
      value: fitField(investmentCardValue),
      inline: false,
    },
  ];

  if (execution) {
    const positionCap = positionCapPercent(execution.signalConfidence, execution.rewardRiskRatio);
    fields.push({
      name: `🎯 Execution Compass (${execution.symbol})`,
      value: fitField(
        [
          `**信号置信度**：${execution.signalConfidence} ${starsFromScore(execution.signalConfidence)} · ${signalLabel(execution.signalConfidence)} · 仓位上限 **${positionCap.toFixed(1)}%**`,
          `**60D 期望**：预期收益 ${signedPercent(execution.expectedReturn60d)} · 预期波动 ${(execution.expectedVolatility60d * 100).toFixed(1)}% · **R:R ${execution.rewardRiskRatio.toFixed(2)}**`,
          `🟢 **Golden Buy Zone**：\`$${execution.goldenBuyLow.toFixed(2)} - $${execution.goldenBuyHigh.toFixed(2)}\``,
          `🟢 **单次进场**：股价缩量回踩 GBZ + Selling Pressure < 35% + 右侧阳线企稳时按仓位上限建仓`,
          `🔴 **动态止损**：\`$${execution.stopLoss.toFixed(2)}\` (2×ATR14)`,
          `🔵 **移动止盈**：达 \`$${execution.valuation.weightedFair.toFixed(2)}\` 减 1/3 并提止损至成本价 \`$${execution.currentPrice.toFixed(2)}\`；破 EMA20 全清`,
        ].join("\n"),
      ),
      inline: false,
    });
  }

  fields.push(
    {
      name: "📌 Portfolio Monitor 状态追踪",
      value: fitField(changes || "暂无状态变化"),
      inline: false,
    },
    {
      name: errorSymbols.length > 0 ? "🟡 数据质量" : "🟢 数据质量",
      value: fitField(
        errorSymbols.length > 0
          ? `局部缺失：${errorSymbols.slice(0, 10).join(", ")}`
          : "所有核心行情源正常",
      ),
      inline: false,
    },
  );

  return {
    content: `🧭 **${report.title}**`,
    embeds: [
      {
        title: `${icon} Market Compass 6.1 每日简报`,
        description: [
          `**${label}** | MSS **${input.marketMetric.mss}/100** | Top: ${displayTop5
            .map((item) => item.stock.symbol)
            .join(", ")}`,
          "",
          insights?.marketNarrative ? `> 💡 **AI 市场解读**：${insights.marketNarrative}` : null,
          insights?.marketNarrative ? "" : null,
          "市场环境 ➔ 资金方向 ➔ 强势资产 ➔ 公司价值 ➔ 合理价格 ➔ 执行纪律",
        ]
          .filter((line) => line !== null)
          .join("\n"),
        color: regimeColor(input.marketMetric.mss),
        fields,
        footer: {
          text: "仅供量化数据与模型演示，不构成投资建议。",
        },
      },
    ],
  };
}

export async function sendDailyReportDiscordWebhook(input: {
  webhookUrl: string;
  reportInput: DailyReportInput;
  report: DailyReport;
  errors?: Record<string, string>;
}): Promise<void> {
  await postDiscordPayload(
    input.webhookUrl,
    renderDailyReportDiscordPayload(input.reportInput, input.report, input.errors),
  );
}
