import type { Instrument } from "@/lib/types/market";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

export type MoatVerdict = {
  score: number; // 1-5
  reason: string; // 一句话说明（20-40 字）
};

const SYSTEM_PROMPT = `你是资深美股行业分析师。给定一只 S&P 500 股票，从五个维度评估其**护城河强度**：
1. 品牌 / 定价权（能否持续提价）
2. 网络效应（用户/数据/开发者三边网络）
3. 规模成本优势（单位成本随规模递减）
4. 转换成本 / 生态锁定（客户离开成本）
5. 无形资产（专利 / 牌照 / 独家数据 / 监管壁垒）

严格返回 JSON，字段固定：
- score: 1-5 整数
  - 5 = 极强，多个维度全部占优（如 NVDA / MSFT / MA / GOOGL）
  - 4 = 强，某个维度垄断
  - 3 = 中等，行业内领先但可替代
  - 2 = 弱，靠周期或规模勉强立足
  - 1 = 无护城河，产品同质化
- reason: 20-40 字，一句话说明打分依据（用中文，可以出现英文缩写）

不要输出任何 JSON 以外的内容。`;

const buildPrompt = (instrument: Instrument): string =>
  `股票代码：${instrument.symbol}
公司名称：${instrument.name}
行业：${instrument.sector ?? "N/A"}
子行业：${instrument.industry ?? "N/A"}

请打分并返回 JSON。`;

const parseVerdict = (raw: string): MoatVerdict | null => {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as { score?: unknown; reason?: unknown };
    const score = typeof parsed.score === "number" ? Math.round(parsed.score) : NaN;
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    if (!Number.isFinite(score) || score < 1 || score > 5) return null;
    if (!reason) return null;
    return { score, reason };
  } catch {
    return null;
  }
};

type FailureKind = "network" | "auth" | "rate-limit" | "server" | "bad-response";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 单只股 Moat 打分。内部做 1 次重试（仅对 network / 429 / 5xx）。
 * 失败原因通过 onFailure 回调外抛，供 batch 层统计与日志。
 */
async function fetchMoatVerdictOnce(
  instrument: Instrument,
  onFailure?: (kind: FailureKind, detail: string) => void,
): Promise<MoatVerdict | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const attempt = async (): Promise<{ verdict: MoatVerdict | null; retryable: boolean; kind: FailureKind; detail: string } | { verdict: MoatVerdict }> => {
    let response: Response;
    try {
      response = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          // 关掉 keep-alive 复用，避免 undici idle TLS 复位（历史 ECONNRESET 案例）
          connection: "close",
        },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildPrompt(instrument) },
          ],
          temperature: 0.3,
          // 120 太紧：中文 reason 30 字 × 2-3 token + JSON 结构 ≈ 110 tokens，边界易被截断成非法 JSON
          max_tokens: 300,
          stream: false,
          response_format: { type: "json_object" },
        }),
        keepalive: false,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { verdict: null, retryable: true, kind: "network", detail };
    }

    if (!response.ok) {
      const status = response.status;
      const retryable = status === 429 || status >= 500;
      const kind: FailureKind = status === 401 || status === 403 ? "auth" : status === 429 ? "rate-limit" : status >= 500 ? "server" : "bad-response";
      return { verdict: null, retryable, kind, detail: `HTTP ${status}` };
    }

    type DeepSeekResponse = {
      choices?: Array<{ message?: { content?: string } }>;
    };
    let data: DeepSeekResponse;
    try {
      data = (await response.json()) as DeepSeekResponse;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { verdict: null, retryable: true, kind: "bad-response", detail };
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { verdict: null, retryable: false, kind: "bad-response", detail: "empty content" };

    const verdict = parseVerdict(content);
    if (!verdict) {
      // 打印前 120 字符便于诊断 JSON 截断 / 结构漂移问题
      const preview = content.slice(0, 120).replace(/\s+/g, " ");
      return {
        verdict: null,
        retryable: true, // parse 失败可能是采样波动，允许 1 次重试
        kind: "bad-response",
        detail: `parse failed: ${preview}`,
      };
    }
    return { verdict };
  };

  const first = await attempt();
  if ("verdict" in first && first.verdict) return first.verdict;
  const firstFailure = first as { retryable: boolean; kind: FailureKind; detail: string };
  if (!firstFailure.retryable) {
    onFailure?.(firstFailure.kind, firstFailure.detail);
    return null;
  }

  // 1 次重试，200ms 后
  await sleep(200);
  const second = await attempt();
  if ("verdict" in second && second.verdict) return second.verdict;
  const secondFailure = second as { retryable: boolean; kind: FailureKind; detail: string };
  onFailure?.(secondFailure.kind, secondFailure.detail);
  return null;
}

// 保留原导出（不再重试的老签名），部分测试脚本用得到
export const fetchMoatVerdict = (instrument: Instrument) => fetchMoatVerdictOnce(instrument);

export type MoatBatchStats = {
  total: number;
  success: number;
  failures: Record<FailureKind, number>;
};

/**
 * 并发抓取 Moat 打分。
 * - 默认并发 2（DeepSeek 免费账户 QPS 保守值），每次请求间隔 200ms 节流；
 * - 单只失败自动重试 1 次；仍失败则记入 stats.failures，不阻塞其他股票；
 * - 返回 { verdicts, stats } —— stats 便于上层落 JobRun.details 观测成功率与失败分布。
 */
export async function fetchMoatVerdictsBatch(
  instruments: Instrument[],
  concurrency = 2,
): Promise<{ verdicts: Map<string, MoatVerdict>; stats: MoatBatchStats }> {
  const verdicts = new Map<string, MoatVerdict>();
  const stats: MoatBatchStats = {
    total: instruments.length,
    success: 0,
    failures: { network: 0, auth: 0, "rate-limit": 0, server: 0, "bad-response": 0 },
  };
  const queue = [...instruments];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const inst = queue.shift();
      if (!inst) return;
      const verdict = await fetchMoatVerdictOnce(inst, (kind, detail) => {
        stats.failures[kind] += 1;
        // 单只失败 log 一行，便于 tail /tmp/dev.log 定位
        console.warn(`[moat] ${inst.symbol} ${kind}: ${detail}`);
      });
      if (verdict) {
        verdicts.set(inst.symbol, verdict);
        stats.success += 1;
      }
      await sleep(200);
    }
  });

  await Promise.all(workers);
  return { verdicts, stats };
}
