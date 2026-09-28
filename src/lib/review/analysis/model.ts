import { appConfig } from "../../../../app.config";
import { z } from "zod";
import { ANALYSIS_SYSTEM_PROMPT, analysisUserPrompt } from "./prompt";
import {
  ANALYSIS_VERSION,
  EVIDENCE_VERSION,
  type AnalysisEvidence,
  type AnalysisOutput,
  type AnalysisReport,
  type ConciseIntelligenceOutput,
} from "./types";

export const DEFAULT_ANALYSIS_MODEL = appConfig.aiModel;
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const MAX_TOKENS = 16_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EVIDENCE_CHARS = 500_000;
const REQUIRED_SECTIONS = ["market", "options", "sectors", "signals", "accounts", "journal", "tomorrow"] as const;
const SECTIONS = [...REQUIRED_SECTIONS, "context"] as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => {
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v;
});
const timestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/)
  .refine((v) => date.safeParse(v.slice(0, 10)).success && Number.isFinite(Date.parse(v)));
// Source observations may be dates or Cboe's timezone-less New York timestamps.
const observation = z.union([date, timestamp, z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/)
  .refine((v) => date.safeParse(v.slice(0, 10)).success && Number.isFinite(Date.parse(`${v}Z`)))]);
const text = (max: number) => z.string().min(1).max(max).refine((v) => v.trim().length > 0);
// The evidence builder URI-encodes composite signal IDs and symbol characters.
const id = z.string().min(1).max(180).regex(/^[A-Za-z0-9](?:[A-Za-z0-9_.:/-]|%[A-Fa-f0-9]{2})*$/);
const unique = (items: string[]) => new Set(items).size === items.length;
const factSchema = z.object({
  id,
  section: z.enum(SECTIONS),
  label: text(300),
  value: z.union([z.number().finite(), z.string().max(4_000), z.boolean(), z.null()]),
  unit: z.string().max(120),
  asOf: observation.nullable(),
  basis: z.string().max(300),
  status: z.enum(["current", "delayed", "stale", "missing", "unknown"]),
  source: z.string().max(500),
  groups: z.array(text(180)).max(20).refine(unique),
  note: z.string().max(2_000).optional(),
}).strict();
const evidenceSchema = z.object({
  version: z.literal(EVIDENCE_VERSION),
  date,
  sourceBuiltAt: timestamp,
  states: z.object({ market: text(100), legacy: text(100), macro: text(100) }).strict(),
  coverage: z.array(z.object({
    section: z.enum(SECTIONS),
    status: z.enum(["available", "partial", "unavailable"]),
    issues: z.array(text(1_000)).max(30),
  }).strict()).min(REQUIRED_SECTIONS.length).max(SECTIONS.length).refine((rows) =>
    unique(rows.map((r) => r.section)) && REQUIRED_SECTIONS.every((section) => rows.some((row) => row.section === section))),
  facts: z.array(factSchema).min(1).max(700).refine((rows) => unique(rows.map((r) => r.id))),
}).strict();
const claimSchema = z.object({
  text: text(240),
  factIds: z.array(id).min(1).max(12).refine(unique),
}).strict();
const legacyOutputSchema = z.object({
  lead: claimSchema.extend({ text: z.string().trim().min(40).max(500), factIds: z.array(id).min(1).max(16).refine(unique) }),
  changes: z.array(claimSchema).max(2),
  divergences: z.array(claimSchema).max(0),
  confirmations: z.array(claimSchema).max(0),
  context: z.array(claimSchema).max(0),
  focus: z.array(claimSchema).max(3),
  limitations: z.array(claimSchema).max(2),
}).strict();
const intelligenceClaimSchema = claimSchema.extend({ text: text(300) });
// A cross-module paragraph can need more citations than the legacy single-topic lead.
const intelligenceSummarySchema = intelligenceClaimSchema.extend({ factIds: z.array(id).min(1).max(32).refine(unique) });
const intelligenceOutputSchema = z.object({
  format: z.literal("market-intelligence-v2"),
  marketRead: intelligenceSummarySchema.extend({ text: text(500) }),
  evidenceMap: z.array(intelligenceClaimSchema).max(6),
  structureRead: intelligenceSummarySchema.extend({ text: text(400) }),
  systemRead: z.array(intelligenceClaimSchema).max(3),
  eventFlowContext: z.array(intelligenceClaimSchema).max(3),
  synthesis: intelligenceSummarySchema.extend({ text: text(600) }),
  validationPoints: z.array(intelligenceClaimSchema).max(4),
}).strict();
const conciseOutputSchema = z.object({
  format: z.literal("market-intelligence-v3"),
  paragraphs: z.array(intelligenceSummarySchema.extend({ text: z.string().trim().min(40).max(600) })).length(2),
}).strict().refine((output) => output.paragraphs.reduce((length, claim) => length + claim.text.length, 0) <= 1_000,
  { path: ["paragraphs"], message: "Combined analysis exceeds length limit" });
const usageSchema = z.object({
  promptTokens: z.number().int().min(0).max(10_000_000),
  completionTokens: z.number().int().min(0).max(10_000_000),
}).strict().nullable();
const modelSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reportSchema = z.object({
  version: z.literal(ANALYSIS_VERSION),
  date,
  generatedAt: timestamp,
  sourceBuiltAt: timestamp,
  sourceHash: hash,
  inputHash: hash,
  promptVersion: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  model: modelSchema,
  evidence: evidenceSchema,
  output: z.union([legacyOutputSchema, intelligenceOutputSchema, conciseOutputSchema]),
  usage: usageSchema,
}).strict();

// Only schema-owned field names and issue codes may appear in logs, never values or unknown keys.
const DIAGNOSTIC_FIELDS = new Set([
  "version", "date", "generatedAt", "sourceBuiltAt", "sourceHash", "inputHash", "promptVersion", "model",
  "evidence", "output", "usage", "states", "market", "legacy", "macro", "coverage", "section", "status", "issues",
  "facts", "id", "label", "value", "unit", "asOf", "basis", "source", "groups", "note", "text", "factIds",
  "lead", "changes", "divergences", "confirmations", "context", "focus", "limitations", "promptTokens", "completionTokens",
  "format", "marketRead", "evidenceMap", "structureRead", "systemRead", "eventFlowContext", "synthesis", "validationPoints",
  "paragraphs",
]);
function schemaFailure(label: string, error: z.ZodError): Error {
  const details = error.issues.slice(0, 4).map((issue) => {
    const path = issue.path.map((part) => typeof part === "number" ? `[${part}]` :
      typeof part === "string" && DIAGNOSTIC_FIELDS.has(part) ? `.${part}` : ".[field]").join("");
    return `$${path}:${issue.code}`;
  });
  return new Error(`${label}（${details.join("; ")}）`);
}

export function parseAnalysisEvidence(value: unknown): AnalysisEvidence {
  const parsed = evidenceSchema.safeParse(value);
  if (!parsed.success) throw schemaFailure("分析证据格式无效", parsed.error);
  if (JSON.stringify(parsed.data).length > MAX_EVIDENCE_CHARS) throw new Error("分析证据超过长度限制");
  return parsed.data;
}

function validateCitations(output: AnalysisOutput, evidence: AnalysisEvidence): void {
  const known = new Set(evidence.facts.map((fact) => fact.id));
  const claims = "format" in output
    ? output.format === "market-intelligence-v3" ? output.paragraphs
      : [output.marketRead, ...output.evidenceMap, output.structureRead, ...output.systemRead,
        ...output.eventFlowContext, output.synthesis, ...output.validationPoints]
    : [output.lead, ...output.changes, ...output.divergences, ...output.confirmations,
      ...output.context, ...output.focus, ...output.limitations];
  if (claims.some((claim) => claim.factIds.some((ref) => !known.has(ref)))) {
    throw new Error("分析引用了不存在的证据");
  }
  if ("format" in output) {
    const conditions = output.format === "market-intelligence-v3" ? output.paragraphs : output.validationPoints;
    for (const claim of conditions) {
      const values = evidence.facts.filter(fact => claim.factIds.includes(fact.id) && typeof fact.value === "number").map(fact => fact.value as number);
      // Catch explicit invented numeric gates, without treating all numbers in prose as trading thresholds.
      // A timeframe label such as 2H/4H is not a numeric gate in connected prose.
      const numericGate = output.format === "market-intelligence-v3"
        ? /(?:高于|低于|超过|跌破|突破|站上|站稳|达到|至少|回升至|降至)\s*(-?\d+(?:\.\d+)?)(?![\d.A-Za-z])/g
        : /(?:高于|低于|超过|跌破|突破|站上|站稳|达到|至少|回升至|降至)\s*(\d+(?:\.\d+)?)/g;
      for (const match of claim.text.matchAll(numericGate)) {
        const value = Number(match[1]), decimals = match[1].split(".")[1]?.length ?? 0;
        if (!values.some(number => Number(number.toFixed(decimals)) === value)) throw new Error("待验证条件使用了引用证据未提供的数值门槛");
      }
    }
  }
}

/** New generations use two concise paragraphs; prior formats remain readable in archives. */
export function parseAnalysisOutput(value: unknown, evidence: AnalysisEvidence): ConciseIntelligenceOutput {
  const checked = parseAnalysisEvidence(evidence);
  const parsed = conciseOutputSchema.safeParse(value);
  if (!parsed.success) throw schemaFailure("分析输出格式或长度无效", parsed.error);
  validateCitations(parsed.data, checked);
  return parsed.data;
}

/** Validate public archives without exposing provider text, Zod input, or credentials in errors. */
export function parseAnalysisReport(value: unknown, expectedDate?: string): AnalysisReport {
  const parsed = reportSchema.safeParse(value);
  if (!parsed.success) throw schemaFailure("分析归档格式无效", parsed.error);
  const report = parsed.data;
  const evidence = parseAnalysisEvidence(report.evidence);
  if ((expectedDate != null && report.date !== expectedDate) || report.date !== evidence.date ||
      report.sourceBuiltAt !== evidence.sourceBuiltAt ||
      Date.parse(report.generatedAt) < Date.parse(report.sourceBuiltAt)) {
    throw new Error("分析归档日期或来源时间不匹配");
  }
  validateCitations(report.output, evidence);
  return report;
}

/** One bounded, server-side request. Only validated final content and token totals are returned. */
export async function generateAnalysis(
  evidence: AnalysisEvidence,
  options: { apiKey: string; model?: string; fetchImpl?: typeof fetch },
): Promise<{ output: ConciseIntelligenceOutput; usage: AnalysisReport["usage"] }> {
  const checked = parseAnalysisEvidence(evidence);
  const apiKey = options.apiKey.trim();
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error("未配置有效的 DeepSeek API 密钥");
  const model = modelSchema.safeParse(options.model ?? DEFAULT_ANALYSIS_MODEL);
  if (!model.success) throw new Error("DeepSeek 模型配置无效");
  const signal = AbortSignal.timeout(240_000);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model.data,
        // Cross-module inference needs reasoning; only validated final prose leaves this function.
        thinking: { type: "enabled" },
        reasoning_effort: "high",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: analysisUserPrompt(checked) },
        ],
        max_tokens: MAX_TOKENS,
        stream: false,
      }),
      cache: "no-store",
      signal,
    });
  } catch {
    throw new Error(signal.aborted ? "DeepSeek 分析请求超时" : "DeepSeek 分析请求失败");
  }
  if (!response.ok) {
    // Do not read or log an untrusted provider error body.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`DeepSeek 分析请求失败（HTTP ${response.status}）`);
  }
  let data: unknown;
  try {
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_RESPONSE_BYTES) throw new Error();
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) throw new Error();
    data = JSON.parse(raw);
  } catch {
    throw new Error(signal.aborted ? "DeepSeek 分析请求超时" : "DeepSeek 响应无效或超过长度限制");
  }
  const finish = z.object({ choices: z.array(z.object({ finish_reason: z.unknown() })).length(1) }).safeParse(data);
  if (finish.success) {
    const reason = finish.data.choices[0].finish_reason;
    if (reason === "length") throw new Error("DeepSeek 分析输出被截断（finish_reason=length）");
    if (reason === "content_filter") throw new Error("DeepSeek 分析输出被过滤（finish_reason=content_filter）");
    if (reason === "tool_calls" || reason === "function_call")
      throw new Error(`DeepSeek 返回了非预期工具请求（finish_reason=${reason}）`);
    if (reason === "insufficient_system_resource")
      throw new Error("DeepSeek 服务资源不足（finish_reason=insufficient_system_resource）");
  }
  const envelope = z.object({
    choices: z.array(z.object({
      finish_reason: z.literal("stop"),
      message: z.object({ content: z.string().trim().min(1).max(30_000) }),
    })).length(1),
    usage: z.object({ prompt_tokens: z.number().int().nonnegative().max(10_000_000),
      completion_tokens: z.number().int().nonnegative().max(10_000_000) }).optional(),
  }).safeParse(data);
  if (!envelope.success) throw new Error("DeepSeek 返回内容为空、被截断或格式无效");
  const content = envelope.data.choices[0].message.content;
  if (content.includes(apiKey)) throw new Error("DeepSeek 返回内容包含不可发布的信息");
  let output: unknown;
  try {
    output = JSON.parse(content);
  } catch {
    throw new Error("DeepSeek 未返回有效的分析 JSON");
  }
  if (JSON.stringify(output).includes(apiKey)) throw new Error("DeepSeek 返回内容包含不可发布的信息");
  return {
    output: parseAnalysisOutput(output, checked),
    usage: envelope.data.usage ? { promptTokens: envelope.data.usage.prompt_tokens,
      completionTokens: envelope.data.usage.completion_tokens } : null,
  };
}
