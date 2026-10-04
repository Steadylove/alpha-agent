import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AgentService, AgentError } from "./service";
import { settingsSchema } from "./store";

const id = "([a-f0-9-]{36})";
const create = z.object({ title: z.string().trim().min(1).max(160).optional(), model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/).optional(),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).optional(), mode: z.literal("research").optional() }).strict();
const patch = z.object({ title: z.string().trim().min(1).max(160).optional(), archived: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0);
const message = z.object({ text: z.string().trim().min(1).max(24000) }).strict();
const decision = z.object({ decision: z.enum(["accept", "decline"]),
  answers: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), z.array(z.string().max(2000)).max(20)).refine(v => Object.keys(v).length <= 32).optional() }).strict();
const empty = z.object({}).strict();
const digest = (s: string) => createHash("sha256").update(s).digest();
async function body(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw new AgentError("请求过大", 413); chunks.push(chunk); }
  if (!size) return {};
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new AgentError("仅支持 JSON", 415);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AgentError("JSON 格式无效"); }
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}
export function createAgentServer(service: AgentService, secret: string) {
  if (secret.length < 32) throw new Error("SITE_AGENT_SECRET 至少需要 32 个字符");
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && path.pathname === "/health" && !path.search) return json(res, { ok: true });
      const authorization = req.headers.authorization ?? "";
      if (!timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`))) return json(res, { error: "未授权" }, 401);
      if (path.search || req.headers.origin) throw new AgentError("不支持此请求", 400);
      const key = `${req.method} ${path.pathname}`;
      if (key === "GET /status") return json(res, await service.status());
      if (key === "GET /threads") return json(res, { threads: service.store.summaries() });
      if (key === "POST /threads") return json(res, service.create(create.parse(await body(req))), 201);
      if (key === "PUT /settings") return json(res, service.settings(settingsSchema.parse(await body(req))));
      if (key === "POST /login") { empty.parse(await body(req)); return json(res, service.startLogin()); }
      const thread = path.pathname.match(new RegExp(`^/threads/${id}$`));
      if (thread) {
        if (req.method === "GET") return json(res, service.store.publicThread(service.store.get(thread[1])));
        if (req.method === "PATCH") return json(res, service.patch(thread[1], patch.parse(await body(req))));
      }
      const action = path.pathname.match(new RegExp(`^/threads/${id}/(messages|interrupt)$`));
      if (action && req.method === "POST") {
        const payload = await body(req);
        if (action[2] === "messages") return json(res, await service.send(action[1], message.parse(payload).text));
        empty.parse(payload); return json(res, await service.interrupt(action[1]));
      }
      const approval = path.pathname.match(new RegExp(`^/threads/${id}/approvals/${id}$`));
      if (approval && req.method === "POST") return json(res, await service.decide(approval[1], approval[2], decision.parse(await body(req))));
      return json(res, { error: "接口不存在" }, 404);
    } catch (error) {
      const status = error instanceof AgentError ? error.status : error instanceof z.ZodError ? 400 : error instanceof Error && error.message === "会话不存在" ? 404 : 503;
      return json(res, { error: error instanceof AgentError ? error.message : status === 400 ? "请求参数无效" : status === 404 ? "会话不存在" : "Codex 服务暂时不可用" }, status);
    }
  });
}
