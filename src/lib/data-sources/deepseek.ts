import type {
  MarketMetric,
  NewsItem,
  ReportInsights,
  SectorScore,
  StockScore,
} from "@/lib/types/market";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

type DeepSeekPayload = {
  marketMetric: MarketMetric;
  sectorScores: SectorScore[];
  topStocks: StockScore[];
  newsItems: NewsItem[];
};

const SYSTEM_PROMPT = `你是资深美股宏观 + 产业链分析师，服务对象是散户社群，输出必须：
1. 严格返回 JSON，字段固定为：
   - marketNarrative (字符串)
   - themeChain (字符串数组)
   - beneficiarySectors (字符串数组)
   - sectorHeadlines (对象：板块名 → 一句 10~20 字的主线定语)
   - featuredQuality (字符串)
2. marketNarrative：一句中文，30~60 字，基于给定的 MSS/尾部/风险偏好/流动性/宽度 五个数字做定性判断（Risk-On/Neutral/Risk-Off + 结构性描述），禁止空话。
3. themeChain：从新闻里提炼今日主导产业链传导，形如 ["AI需求爆发", "云计算CAPEX上修", "GPU/HBM需求拉满"]，2~5 个环节。
4. beneficiarySectors：3~5 个受益板块中文短语。
5. sectorHeadlines：为传入的每一个板块（**必须用给定的英文原名做 key，不要翻译**）写一句主线叙述，例如 {"Technology": "第一主线：AI Infrastructure", "Energy": "油价推动能源反弹", "Health Care": "创新药研发管线扩容"}。
6. featuredQuality：一句 20~40 字，用于描述"首推标的"的行业定位/护城河/催化，如 "CUDA 平台化垄断，云厂订单锁定至 2027"。
7. 不要出现任何免责声明、投资建议、寒暄或解释。只返回 JSON，不加代码块。`;

const buildUserPrompt = (payload: DeepSeekPayload) => {
  const macro = payload.marketMetric;
  const macroLine = `MSS=${macro.mss}/100, 尾部=${macro.skewScore ?? "N/A"}/25, 风险偏好=${
    macro.pcrScore ?? "N/A"
  }/25, 流动性=${macro.creditScore ?? "N/A"}/25, 宽度=${macro.breadthScore ?? "N/A"}/25`;

  const topSectors = payload.sectorScores
    .slice(0, 5)
    .map((s) => `${s.name}(RS21=${(s.rs21 * 100).toFixed(1)}%,score=${s.score})`)
    .join("; ");

  const topStocksLine = payload.topStocks
    .slice(0, 5)
    .map((s) => `${s.symbol}(${s.sector},score=${s.finalCompassScore})`)
    .join("; ");

  const featured = payload.topStocks[0];
  const featuredLine = featured
    ? `${featured.symbol} (${featured.name}, ${featured.sector}, Final Compass=${featured.finalCompassScore})`
    : "无";

  const newsLines = payload.newsItems
    .slice(0, 12)
    .map((n, i) => `${i + 1}. ${n.headline}${n.relatedSymbols.length ? ` [${n.relatedSymbols.slice(0, 4).join(",")}]` : ""}`)
    .join("\n");

  return `【今日宏观】${macroLine}
【领涨行业(需为每一个生成 sectorHeadlines)】${topSectors}
【Top 5 强势股】${topStocksLine}
【首推标的(需生成 featuredQuality)】${featuredLine}
【新闻摘要】
${newsLines}

请输出 JSON。`;
};

const parseInsights = (raw: string): ReportInsights | null => {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as Partial<ReportInsights> & {
      sectorHeadlines?: Record<string, unknown>;
      featuredQuality?: unknown;
    };
    if (
      typeof parsed.marketNarrative !== "string" ||
      !Array.isArray(parsed.themeChain) ||
      !Array.isArray(parsed.beneficiarySectors)
    ) {
      return null;
    }
    const sectorHeadlines: Record<string, string> = {};
    if (parsed.sectorHeadlines && typeof parsed.sectorHeadlines === "object") {
      for (const [key, value] of Object.entries(parsed.sectorHeadlines)) {
        if (typeof value === "string" && value.trim()) sectorHeadlines[key] = value.trim();
      }
    }
    return {
      marketNarrative: parsed.marketNarrative.trim(),
      themeChain: parsed.themeChain.map((v) => String(v).trim()).filter(Boolean),
      beneficiarySectors: parsed.beneficiarySectors.map((v) => String(v).trim()).filter(Boolean),
      sectorHeadlines,
      featuredQuality:
        typeof parsed.featuredQuality === "string" && parsed.featuredQuality.trim()
          ? parsed.featuredQuality.trim()
          : null,
    };
  } catch {
    return null;
  }
};

export async function generateReportInsights(
  payload: DeepSeekPayload,
): Promise<ReportInsights | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  let response: Response;
  try {
    response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(payload) },
        ],
        temperature: 0.3,
        max_tokens: 500,
        stream: false,
        response_format: { type: "json_object" },
      }),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  type DeepSeekResponse = {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const data = (await response.json()) as DeepSeekResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;

  return parseInsights(content);
}
