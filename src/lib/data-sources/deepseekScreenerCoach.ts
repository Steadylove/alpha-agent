import type { ScreenerResult, ScreenerRow } from "@/lib/jobs/alphaScreener";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

export type ScreenerCoaching = {
  opportunity: string;
  risk: string;
  lesson: string;
};

const SYSTEM_PROMPT = `你是量化交易复盘教练，精通多周期RPS因子、斯坦·温斯顿阶段理论和威廉·欧奈尔的CANSLIM系统。
任务：根据我提供的「今日筛选日志」，提炼交易心得，发现模式，指出盲点。输出必须简短。

严格遵循：
1. 只基于我提供的数据分析，不做任何外部预测；数据不足时在对应字段写明缺什么，不要编造。
2. 所有分析必须关联三大战法框架：短周期塌陷法（买中继）、绝对上限封印法（防见顶）、多头加速穿越法（买初期），以及四周期共振（RPS20/50/120/250）。
3. 重点关注RPS周期的结构关系（如20相对50的压制/共振、长中短排列），而不是孤立报数字。若日志只有当日快照、没有历史对比，不要假装看到了「从X回升至Y」。
4. 区分买点信号、持仓评估和风险信号：哪些符合预期，哪些需要警惕。
5. 若多个案例出现相似结构，提炼一条可复用规则。

请严格返回 JSON（不要代码块），字段固定：
- opportunity: 2~4 句中文。哪一种战法今天给出了最多潜在买点？信号是否可靠？结合具体代码与RPS结构说明。
- risk: 2~4 句中文。有没有战法发出普遍预警（如封印法过热、共振过密）？是否提示整体情绪亢奋？
- lesson: 1~2 句中文。一条简短可记忆的交易心得，尽量挂钩「买在分歧，卖在一致」或「截断亏损，让利润奔跑」，并点名至少一只日志里的股票代码。`;

function fmtRow(row: ScreenerRow): string {
  return `${row.symbol} RPS20=${row.rps[20].toFixed(1)} RPS50=${row.rps[50].toFixed(1)} RPS120=${row.rps[120].toFixed(1)} RPS250=${row.rps[250].toFixed(1)}`;
}

function buildUserPrompt(result: ScreenerResult): string {
  const eliteLines =
    result.elite.length === 0
      ? "（无）"
      : result.elite.map((r) => fmtRow(r)).join("\n");

  const playbookBlocks = result.buckets
    .map((b) => {
      const header = `【${b.meta.name}】规则=${b.meta.rule} · 命中=${b.totalMatches}`;
      if (b.picks.length === 0) return `${header}\n（无命中）`;
      return `${header}\n${b.picks.map((r) => fmtRow(r)).join("\n")}`;
    })
    .join("\n\n");

  return `【今日筛选日志 · 快照】
日期UTC：${result.generatedAt.toISOString().slice(0, 10)}
宇宙：S&P500 universe=${result.universeSize} · 可排名=${result.rankedSize}
说明：以下仅为当日横截面RPS，无昨日对比，请勿编造结构变化轨迹。

【四周期共振强势池 · RPS均>${result.baseThreshold}】命中=${result.elite.length}
${eliteLines}

${playbookBlocks}

请完成：机会在哪里 / 风险在哪里 / 感悟提炼。返回 JSON。`;
}

function parseCoaching(raw: string): ScreenerCoaching | null {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<ScreenerCoaching>;
    const opportunity = typeof parsed.opportunity === "string" ? parsed.opportunity.trim() : "";
    const risk = typeof parsed.risk === "string" ? parsed.risk.trim() : "";
    const lesson = typeof parsed.lesson === "string" ? parsed.lesson.trim() : "";
    if (!opportunity || !risk || !lesson) return null;
    return { opportunity, risk, lesson };
  } catch {
    return null;
  }
}

/** 基于当日 screener 结果生成简短复盘；无 key / 失败时返回 null */
export async function generateScreenerCoaching(
  result: ScreenerResult,
): Promise<ScreenerCoaching | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  let response: Response;
  try {
    response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        connection: "close",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(result) },
        ],
        temperature: 0.4,
        max_tokens: 800,
        stream: false,
        response_format: { type: "json_object" },
      }),
      keepalive: false,
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

  return parseCoaching(content);
}
