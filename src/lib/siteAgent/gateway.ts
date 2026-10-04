import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AgentHttpError, agentConfig, clientKey, issueSession, passwordMatches, rateLimit,
  readAgentJson, readBoundedBody, requireSameOrigin, sessionCookie, sessionToken, verifySession,
} from "./auth";

const noStore = { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
export function agentJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...noStore, ...headers } });
}

function failure(error: unknown): Response {
  if (error instanceof AgentHttpError) return agentJson({ error: error.message }, error.status, error.status === 429 ? { "Retry-After": "60" } : {});
  return agentJson({ error: "工作台服务暂时不可用" }, 503);
}

export async function handleAgentSession(request: Request): Promise<Response> {
  try {
    const config = agentConfig();
    if (request.method === "GET") return agentJson({ authenticated: !!config && verifySession(sessionToken(request, config), config), configured: !!config });
    if (request.method === "DELETE") {
      if (request.headers.get("x-site-agent-request") !== "1") requireSameOrigin(request);
      if (!z.object({}).strict().safeParse(await readAgentJson(request, true)).success) throw new AgentHttpError(400, "请求内容无效");
      return agentJson({ authenticated: false, configured: !!config }, 200, { "Set-Cookie": sessionCookie("", process.env.NODE_ENV === "production") });
    }
    if (request.method !== "POST") throw new AgentHttpError(405, "不支持的操作");
    if (!config) throw new AgentHttpError(503, "工作台尚未配置");
    rateLimit(`login:global`, 100, 15 * 60_000);
    rateLimit(`login:${clientKey(request)}`, 10, 15 * 60_000);
    const result = z.object({ password: z.string().min(1).max(1024) }).strict().safeParse(await readAgentJson(request));
    if (!result.success) throw new AgentHttpError(400, "请求内容无效");
    if (!passwordMatches(result.data.password, config)) throw new AgentHttpError(401, "管理员密码不正确");
    return agentJson({ authenticated: true, configured: true }, 200, { "Set-Cookie": sessionCookie(issueSession(config), config.production) });
  } catch (error) { return failure(error); }
}

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const title = z.string().trim().min(1).max(160);
const mode = z.enum(["research", "workspace"]);
const settings = z.object({
  dailyTurnLimit: z.number().int().min(0).max(500),
  dailyTokenBudget: z.number().int().min(0).max(5_000_000),
  maxTaskMinutes: z.number().int().min(1).max(120),
});
const empty = z.object({}).strict();
const createThread = z.object({ title: title.optional(), model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/).optional(), effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(), mode: z.literal("research").optional() }).strict();
const patchThread = z.object({ title: title.optional(), archived: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0);
const message = z.object({ text: z.string().trim().min(1).max(24_000) }).strict();
const approval = z.object({ decision: z.enum(["accept", "decline"]), answers: z.record(identifier, z.array(z.string().max(2000)).max(20)).refine(value => Object.keys(value).length <= 32).optional() }).strict();

// Only the public contract crosses the gateway. Extra RPC fields (including
// credentials and reasoning) are discarded even if a worker accidentally adds them.
const summary = z.object({ id: identifier, title: z.string(), createdAt: z.string(), updatedAt: z.string(), status: z.enum(["idle", "running", "waiting", "failed", "interrupted"]), model: z.string(), effort: z.string(), mode, archived: z.boolean(), inputTokens: z.number(), outputTokens: z.number() });
const publicApproval = z.object({ id: identifier, kind: z.enum(["command", "file", "question"]), title: z.string(), detail: z.string(), questions: z.array(z.object({ id: z.string(), header: z.string(), question: z.string(), options: z.array(z.object({ label: z.string(), description: z.string() })).optional() })).optional() });
const publicWorkerMessages = new Set([
  "任务已由你停止。", "任务达到工作台时长上限，已请求停止。",
  "Codex 进程断开，任务未自动重试。", "请先授权 Codex 账号",
  "该账号暂未返回可用的额度窗口", "暂时无法读取订阅额度；不会将未知额度视为零。",
]);
const safeWorkerError = z.string().nullable().transform(value => value === null || publicWorkerMessages.has(value) ? value : "服务暂时不可用，请稍后重试");
const thread = summary.extend({ messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), text: z.string(), createdAt: z.string() })), activities: z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), status: z.string(), detail: z.string().optional() })), approvals: z.array(publicApproval), error: safeWorkerError });
const login = z.object({ status: z.enum(["idle", "pending", "complete", "failed"]), url: z.url({ protocol: /^https$/ }).optional(), code: z.string().optional(), error: z.string().transform(() => "授权暂时不可用，请重试").optional() });
const status = z.object({
  available: z.boolean(), authenticated: z.boolean(), account: z.object({ type: z.string(), plan: z.string().nullable() }).nullable(),
  models: z.array(z.object({ id: z.string(), name: z.string(), efforts: z.array(z.string()), defaultEffort: z.string(), isDefault: z.boolean() })),
  quota: z.object({ windows: z.array(z.object({ name: z.string(), usedPercent: z.number(), windowMinutes: z.number(), resetsAt: z.number() })), error: safeWorkerError, updatedAt: z.string().nullable() }),
  settings, usage: z.object({ date: z.string(), turns: z.number(), inputTokens: z.number(), outputTokens: z.number(), activeTasks: z.number() }), login, error: safeWorkerError,
});

type Operation = "status" | "listThreads" | "createThread" | "getThread" | "patchThread" | "message" | "interrupt" | "approval" | "settings" | "login";
type Route = { method: string; path: string; input?: z.ZodType; output: z.ZodType; emptyBody?: boolean };
function routeFor(operation: Operation, params: { id?: string; approvalId?: string }): Route {
  const threadPath = () => {
    if (!identifier.safeParse(params.id).success) throw new AgentHttpError(400, "会话标识无效");
    return `/threads/${params.id}`;
  };
  switch (operation) {
    case "status": return { method: "GET", path: "/status", output: status };
    case "listThreads": return { method: "GET", path: "/threads", output: z.object({ threads: z.array(summary) }) };
    case "createThread": return { method: "POST", path: "/threads", input: createThread, output: thread };
    case "getThread": return { method: "GET", path: threadPath(), output: thread };
    case "patchThread": return { method: "PATCH", path: threadPath(), input: patchThread, output: thread };
    case "message": return { method: "POST", path: `${threadPath()}/messages`, input: message, output: thread };
    case "interrupt": return { method: "POST", path: `${threadPath()}/interrupt`, input: empty, output: thread, emptyBody: true };
    case "approval": {
      if (!identifier.safeParse(params.approvalId).success) throw new AgentHttpError(400, "审批标识无效");
      return { method: "POST", path: `${threadPath()}/approvals/${params.approvalId}`, input: approval, output: thread };
    }
    case "settings": return { method: "PUT", path: "/settings", input: settings.strict(), output: settings };
    case "login": return { method: "POST", path: "/login", input: empty, output: login, emptyBody: true };
    default: throw new AgentHttpError(404, "接口不存在");
  }
}

export async function forwardAgentRequest(request: Request, operation: Operation, params: { id?: string; approvalId?: string } = {}): Promise<Response> {
  try {
    const config = agentConfig();
    if (!config) throw new AgentHttpError(503, "工作台尚未配置");
    const token = sessionToken(request, config);
    if (!verifySession(token, config)) throw new AgentHttpError(401, "请先登录管理员账户");
    const route = routeFor(operation, params);
    if (request.method !== route.method) throw new AgentHttpError(405, "不支持的操作");
    if (new URL(request.url).search) throw new AgentHttpError(400, "请求参数无效");
    // SameSite=Strict protects the owner cookie from cross-site requests. The
    // client marker covers embedded/local browsers that omit Origin on POST;
    // requests without either signal still use the strict origin check.
    if (route.method !== "GET" && request.headers.get("x-site-agent-request") !== "1") requireSameOrigin(request);
    const sessionKey = createHash("sha256").update(token).digest("hex");
    rateLimit(`${route.method === "GET" ? "read" : "write"}:${sessionKey}`, route.method === "GET" ? 180 : 30, 60_000);
    let body: string | undefined;
    if (route.input) {
      const parsed = route.input.safeParse(await readAgentJson(request, route.emptyBody));
      if (!parsed.success) throw new AgentHttpError(400, "请求内容无效");
      body = JSON.stringify(parsed.data);
    }
    let upstream: Response;
    try {
      upstream = await fetch(`${config.workerUrl}${route.path}`, {
        method: route.method, body, headers: { Authorization: `Bearer ${config.workerSecret}`, "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(25_000),
      });
    } catch { throw new AgentHttpError(503, "工作台服务暂时不可用"); }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      const errors: Record<number, string> = { 400: "请求内容无效", 404: "会话或审批不存在", 409: "当前状态不允许此操作", 429: "已达到操作或任务额度，请稍后重试" };
      throw new AgentHttpError(errors[upstream.status] ? upstream.status : 503, errors[upstream.status] ?? "工作台服务暂时不可用");
    }
    let parsed: z.ZodSafeParseResult<unknown>;
    try { parsed = route.output.safeParse(JSON.parse(await readBoundedBody(upstream, 2 * 1024 * 1024))); }
    catch { throw new AgentHttpError(502, "工作台服务返回无效内容"); }
    if (!parsed.success) throw new AgentHttpError(502, "工作台服务返回无效内容");
    // Defense in depth for known deployment secrets accidentally echoed by tools.
    let json = JSON.stringify(parsed.data);
    for (const secret of [config.password, config.sessionSecret, config.workerSecret]) json = json.split(JSON.stringify(secret).slice(1, -1)).join("[已隐藏]");
    return agentJson(JSON.parse(json), upstream.status === 201 ? 201 : 200);
  } catch (error) { return failure(error); }
}
