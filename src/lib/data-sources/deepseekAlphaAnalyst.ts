import type { ScreenerRow } from "@/lib/jobs/alphaScreener";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

const SYSTEM_PROMPT = `Market Compass RPS Alpha Analyst

你是一名顶级买方股票研究员，负责分析 Market Compass RPS 强势股票池。

你的任务不是预测股价，而是研究：
为什么这只股票进入市场领导者名单，以及未来是否可能继续保持 Alpha。

我会提供：
- 股票代码
- 行业
- RPS250、RPS120、RPS50、RPS20
- 当前价格
- 成交量变化（如有）

请按照以下结构进行完整的内心推演分析（1-7）：

1. RPS结构分析
分析四周期：
- RPS250：长期市场认可度
- RPS120：机构资金趋势
- RPS50：中期攻击力度
- RPS20：短期资金行为
判断：属于 (强势延续 / 加速突破 / 健康调整 / 高位拥挤 / 强度衰退) 中的哪一种，并说明原因。

2. 资金行为分析
回答：为什么市场资金正在买它？
分析：行业资金流向、公司盈利趋势、周期位置、市场主题、机构偏好。
如果没有明确原因，注明：“价格强度领先，基本面需要进一步验证。” 不要强行解释。

3. 趋势质量分析
观察：是否处于长期上涨趋势，是否接近历史高位，是否出现过度上涨，是否存在正常回调机会。

4. 量价分析（如提供成交量）
判断：
上涨：是否伴随成交量扩张？
下跌：是否缩量？
分类：健康吸筹 (上涨放量，下跌缩量) 或 风险 (上涨无量，下跌放量)。

5. 基本面快速检查
只回答三个问题：盈利是否支持当前趋势？未来6个月最大的增长驱动是什么？最大的风险是什么？
不要展开长篇报告。

6. 估值快速判断
输出当前估值：便宜 / 合理 / 偏贵 / 极端
回答：市场是否已经提前交易未来增长？
如果需要进一步研究，标记：“进入深度估值分析”。

7. 综合评分
输出 Market Compass Alpha Score (满分100：RPS结构 40分, 趋势质量 20分, 基本面 20分, 估值 20分)

在内心推演完成后，请【务必】以以下精确的结构输出最终结果。请直接输出这部分内容和推演过程（使用清晰的 Markdown 排版，方便阅读）。

**最终输出：**
**股票**：{代码}
**行业**：{行业}
**RPS**: 
- 250: {值}
- 120: {值}
- 50: {值}
- 20: {值}

**当前状态**: 
[★★★★★重点观察 或 ★★★★继续跟踪 或 ★★★等待确认 或 ★★风险]

**核心逻辑**：
[一两句话总结]

**主要风险**：
[一两句话总结]

**下一步**：
[继续观察 / 进入深度研究 / 淘汰]
`;

export async function generateAlphaAnalysis(
  row: ScreenerRow,
  currentPrice: number,
  volumeChange?: number
): Promise<string | null> {
  // Try finding DEEPSEEK_API_KEY from env
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const volText =
    volumeChange !== undefined
      ? `\n成交量变化: ${volumeChange >= 0 ? "+" : ""}${(volumeChange * 100).toFixed(2)}%`
      : "";

  const prompt = `股票代码: ${row.symbol}
行业: ${row.industryLabel}
RPS250: ${Math.round(row.rps[250])}
RPS120: ${Math.round(row.rps[120])}
RPS50: ${Math.round(row.rps[50])}
RPS20: ${Math.round(row.rps[20])}
当前价格: $${currentPrice.toFixed(2)}${volText}`;

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        // For analysis, deepseek-chat works perfectly well. Can use deepseek-reasoner for advanced CoT.
        model: "deepseek-v4-pro",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 3000,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Deepseek alpha analysis error:", response.status, response.statusText, errText);
      return null;
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    console.error("Deepseek API Error:", e);
    return null;
  }
}
