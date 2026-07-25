import type { Playbook } from "@/lib/scoring/rpsPlaybooks";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const SOURCE = "screener-llm";
const DRIFT_THRESHOLD = 0.25;

export type ScenarioKey = "bear" | "base" | "bull";

export type ScenarioDrivers = {
  productPrice: string;
  revenueGrowth: string;
  margin: string;
  exitMultiple: string;
};

export type ValuationScenarioRow = {
  key: ScenarioKey;
  probability: number;
  drivers: ScenarioDrivers;
  targetPrice: number;
};

export type HistoricalTargetSummary = {
  date: string;
  weightedFair: number;
  baseTarget: number;
  bearTarget: number;
  bullTarget: number;
};

export type ValuationInput = {
  symbol: string;
  currentPrice: number;
  playbooks: Playbook[];
  rps: { r20: number; r50: number; r120: number; r250: number };
  fundamentals: {
    analystTargetPrice: number | null;
    revenueGrowth: number | null;
    grossMargin: number | null;
    fcfMargin: number | null;
    roic: number | null;
    marketCap: number | null;
  };
  history: HistoricalTargetSummary[];
};

export type ValuationScenarioResult = {
  symbol: string;
  currentPrice: number;
  method: string;
  methodWhy: string;
  scenarios: ValuationScenarioRow[];
  bearTarget: number;
  baseTarget: number;
  bullTarget: number;
  weightedFair: number;
  anchorNote: string;
  driftFlag: boolean;
  driftPct: number | null;
  playbooks: Playbook[];
};

const PROB: Record<ScenarioKey, number> = {
  bear: 0.2,
  base: 0.55,
  bull: 0.25,
};

const SYSTEM_PROMPT = `你是卖方研究出身的估值分析师，服务量化交易员的每日筛选复盘。
基于我提供的标的快照与历史目标价，做「估值与情景分析」。只基于给定数据，不编造未提供的财报细节。

严格返回 JSON（不要代码块），字段固定：
{
  "method": "dcf|sotp|comps|hybrid 之一",
  "methodWhy": "1~2句中文，解释为何该方法最适用",
  "scenarios": {
    "bear": {
      "drivers": {
        "productPrice": "短假设",
        "revenueGrowth": "短假设",
        "margin": "短假设",
        "exitMultiple": "短假设"
      },
      "targetPrice": number
    },
    "base": { 同上 },
    "bull": { 同上 }
  },
  "anchorNote": "1~2句：相对历史目标价如何调整；若无历史则说明首次定价"
}

规则：
1. 情景概率固定：空头20% / 基础55% / 多头25%（你无需输出概率字段）。
2. 目标价为未来约6个月合理区间价，单位美元；bear < base < bull。
3. 若提供历史目标价：相对最近一次 weightedFair，变动尽量 ≤15%；除非基本面/分析师目标有显著依据，才允许更大偏离，并在 anchorNote 说明。
4. 有分析师共识目标价时，base 应以其为重要锚，可小幅调整。
5. drivers 每条不超过 20 个中文字/英文词，具体可量化更好。
6. 不要输出投资建议口号或免责声明。`;

function fmtPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "N/A";
  return `${(v * 100).toFixed(1)}%`;
}

function buildUserPrompt(input: ValuationInput): string {
  const hist =
    input.history.length === 0
      ? "（无历史目标价，本次为首次）"
      : input.history
          .map(
            (h) =>
              `${h.date}: PWFV=${h.weightedFair.toFixed(2)} base=${h.baseTarget.toFixed(2)} bear=${h.bearTarget.toFixed(2)} bull=${h.bullTarget.toFixed(2)}`,
          )
          .join("\n");

  const f = input.fundamentals;
  return `【标的】${input.symbol}
【现价】${input.currentPrice.toFixed(2)}
【战法标签】${input.playbooks.join(", ") || "无"}
【RPS】20=${input.rps.r20.toFixed(1)} 50=${input.rps.r50.toFixed(1)} 120=${input.rps.r120.toFixed(1)} 250=${input.rps.r250.toFixed(1)}
【基本面快照】
分析师共识目标价=${f.analystTargetPrice ?? "N/A"}
收入增长=${fmtPct(f.revenueGrowth)}
毛利率=${fmtPct(f.grossMargin)}
FCF利润率=${fmtPct(f.fcfMargin)}
ROIC=${fmtPct(f.roic)}
市值=${f.marketCap != null ? f.marketCap.toFixed(0) : "N/A"}
【历史目标价（近→远，最多5条）】
${hist}

请输出估值与三情景 JSON。`;
}

function asDrivers(raw: unknown): ScenarioDrivers | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const keys = ["productPrice", "revenueGrowth", "margin", "exitMultiple"] as const;
  const out = {} as ScenarioDrivers;
  for (const k of keys) {
    if (typeof d[k] !== "string" || !d[k].trim()) return null;
    out[k] = d[k].trim();
  }
  return out;
}

function parseScenarioBlock(
  key: ScenarioKey,
  raw: unknown,
): Omit<ValuationScenarioRow, "probability"> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { drivers?: unknown; targetPrice?: unknown };
  const drivers = asDrivers(o.drivers);
  const targetPrice = typeof o.targetPrice === "number" ? o.targetPrice : Number(o.targetPrice);
  if (!drivers || !Number.isFinite(targetPrice) || targetPrice <= 0) return null;
  return { key, drivers, targetPrice: Number(targetPrice.toFixed(2)) };
}

function parseValuation(
  symbol: string,
  currentPrice: number,
  playbooks: Playbook[],
  history: HistoricalTargetSummary[],
  raw: string,
): ValuationScenarioResult | null {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as {
      method?: unknown;
      methodWhy?: unknown;
      scenarios?: Record<string, unknown>;
      anchorNote?: unknown;
    };

    const method = typeof parsed.method === "string" ? parsed.method.trim() : "";
    const methodWhy = typeof parsed.methodWhy === "string" ? parsed.methodWhy.trim() : "";
    const anchorNote = typeof parsed.anchorNote === "string" ? parsed.anchorNote.trim() : "";
    if (!method || !methodWhy || !anchorNote || !parsed.scenarios) return null;

    const bear = parseScenarioBlock("bear", parsed.scenarios.bear);
    const base = parseScenarioBlock("base", parsed.scenarios.base);
    const bull = parseScenarioBlock("bull", parsed.scenarios.bull);
    if (!bear || !base || !bull) return null;

    // 保证顺序：若模型颠倒，按数值重排并保留各自 drivers
    const ordered = [bear, base, bull].sort((a, b) => a.targetPrice - b.targetPrice);
    const bearT = ordered[0].targetPrice;
    const baseT = ordered[1].targetPrice;
    const bullT = ordered[2].targetPrice;

    const scenarios: ValuationScenarioRow[] = [
      { ...ordered[0], key: "bear", probability: PROB.bear },
      { ...ordered[1], key: "base", probability: PROB.base },
      { ...ordered[2], key: "bull", probability: PROB.bull },
    ];

    const weightedFair = Number((0.2 * bearT + 0.55 * baseT + 0.25 * bullT).toFixed(2));

    const last = history[0] ?? null;
    let driftPct: number | null = null;
    let driftFlag = false;
    if (last && last.weightedFair > 0) {
      driftPct = (weightedFair - last.weightedFair) / last.weightedFair;
      driftFlag = Math.abs(driftPct) > DRIFT_THRESHOLD;
    }

    return {
      symbol,
      currentPrice,
      method,
      methodWhy,
      scenarios,
      bearTarget: bearT,
      baseTarget: baseT,
      bullTarget: bullT,
      weightedFair,
      anchorNote,
      driftFlag,
      driftPct,
      playbooks,
    };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generateOne(input: ValuationInput): Promise<ValuationScenarioResult | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const attempt = async (): Promise<ValuationScenarioResult | null> => {
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
            { role: "user", content: buildUserPrompt(input) },
          ],
          temperature: 0.3,
          max_tokens: 900,
          stream: false,
          response_format: { type: "json_object" },
        }),
        keepalive: false,
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;
    type DeepSeekResponse = { choices?: Array<{ message?: { content?: string } }> };
    const data = (await response.json()) as DeepSeekResponse;
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    return parseValuation(input.symbol, input.currentPrice, input.playbooks, input.history, content);
  };

  const first = await attempt();
  if (first) return first;
  await sleep(250);
  return attempt();
}

export async function generateValuationsBatch(
  inputs: ValuationInput[],
  concurrency = 2,
): Promise<ValuationScenarioResult[]> {
  const results: ValuationScenarioResult[] = [];
  const queue = [...inputs];

  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) return;
      const v = await generateOne(item);
      if (v) results.push(v);
      else console.warn(`[valuation] ${item.symbol} failed`);
      await sleep(200);
    }
  });

  await Promise.all(workers);
  // 保持与输入相近的稳定顺序
  const order = new Map(inputs.map((i, idx) => [i.symbol, idx]));
  results.sort((a, b) => (order.get(a.symbol) ?? 0) - (order.get(b.symbol) ?? 0));
  return results;
}

export { SOURCE as VALUATION_SOURCE };
