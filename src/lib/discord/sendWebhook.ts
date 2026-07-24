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

const statusIcon = (status: string) => {
  if (status === "FOCUS") return "⭐";
  if (status === "NEW") return "🆕";
  if (status === "WATCH") return "👀";
  return "⚠️";
};

const statusLabelZh = (status: string) => {
  if (status === "FOCUS") return "核心关注";
  if (status === "NEW") return "新加入";
  if (status === "WATCH") return "观察";
  return "降级";
};

const signedPercent = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;

const truncate = (value: string, maxLength: number) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;

export function renderDailyReportDiscordPayload(
  input: DailyReportInput,
  report: DailyReport,
  errors: Record<string, string> = {},
): DiscordPayload {
  const topSectors = input.sectorScores
    .slice(0, 3)
    .map((sector) =>
      [
        `**${sector.rank}. ${sector.name}**`,
        `\`${sector.symbol}\``,
        `分数 **${sector.score}**`,
        `21D ${signedPercent(sector.rs21)}`,
        `63D ${signedPercent(sector.rs63)}`,
      ].join("  ·  "),
    )
    .join("\n");

  const topStocks = input.stockScores
    .slice(0, 5)
    .map((stock) =>
      [
        `${statusIcon(stock.status)} **${stock.rank}. ${stock.symbol}**`,
        `总分 **${stock.totalScore}**`,
        `RPS ${stock.rpsScore}`,
        `趋势 ${stock.trendScore}`,
        statusLabelZh(stock.status),
      ].join("  ·  "),
    )
    .join("\n");

  const changes = input.watchlistChanges
    .slice(0, 5)
    .map((change) =>
      `**${change.symbol}**：${change.previous ? statusLabelZh(change.previous) : "无"} → **${statusLabelZh(
        change.current,
      )}**  ·  ${change.reason}`,
    )
    .join("\n");
  const news = input.newsItems
    .slice(0, 3)
    .map((item, index) => {
      const symbols = item.relatedSymbols.length > 0 ? item.relatedSymbols.join(",") : "-";
      return `${index + 1}. [${truncate(item.headline, 88)}](${item.url})\n   相关标的：\`${symbols}\``;
    })
    .join("\n\n");

  const errorSymbols = Object.keys(errors);
  const icon = regimeIcon(input.marketMetric.mss);
  const label = regimeLabelZh(input.marketMetric.mss);
  const insights = input.insights;

  const catalystValue = [
    insights?.themeChain && insights.themeChain.length > 0
      ? `**🚀 核心逻辑链**：${insights.themeChain.join(" → ")}`
      : null,
    insights?.beneficiarySectors && insights.beneficiarySectors.length > 0
      ? `**🟢 核心受益方向**：${insights.beneficiarySectors.join(" | ")}`
      : null,
    news || null,
  ]
    .filter(Boolean)
    .join("\n\n") || "暂无新闻数据";

  return {
    content: `🧭 **${report.title}**`,
    embeds: [
      {
        title: `${icon} Market Compass 每日简报`,
        description: [
          `**${label}** | MSS **${input.marketMetric.mss}/100** | Top: ${input.stockScores
            .slice(0, 5)
            .map((stock) => stock.symbol)
            .join(", ")}`,
          "",
          insights?.marketNarrative ? `> 💡 **AI 市场解读**：${insights.marketNarrative}` : null,
          insights?.marketNarrative ? "" : null,
          "市场环境 → 资金方向 → 强势资产 → 执行纪律",
        ]
          .filter((line) => line !== null)
          .join("\n"),
        color: regimeColor(input.marketMetric.mss),
        fields: [
          {
            name: "📊 市场状态",
            value: [
              `MSS：**${input.marketMetric.mss}/100**`,
              `置信度：${Math.round(input.marketMetric.confidence * 100)}%`,
              `信用代理：${input.marketMetric.creditScore ?? "缺失"}/25`,
              `市场宽度：${input.marketMetric.breadthScore ?? "缺失"}/25`,
            ].join("  |  "),
            inline: false,
          },
          {
            name: "🔄 行业资金罗盘 Top 3",
            value: topSectors || "暂无行业评分",
            inline: false,
          },
          {
            name: "📰 今日新闻催化",
            value: catalystValue,
            inline: false,
          },
          {
            name: "🚀 强势股票池 Top 5",
            value: topStocks || "暂无股票评分",
            inline: false,
          },
          {
            name: "📌 股票状态追踪",
            value: changes || "暂无状态变化",
            inline: false,
          },
          {
            name: errorSymbols.length > 0 ? "🟡 数据质量" : "🟢 数据质量",
            value: errorSymbols.length > 0 ? `局部缺失：${errorSymbols.join(", ")}` : "所有核心行情源正常",
            inline: false,
          },
        ],
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
