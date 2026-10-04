import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_SECONDS = 8 * 60 * 60;
export const BODY_LIMIT = 32 * 1024;
type Environment = Record<string, string | undefined>;
export type AgentConfig = { password: string; sessionSecret: string; workerSecret: string; workerUrl: string; production: boolean };

export class AgentHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function agentConfig(env: Environment = process.env): AgentConfig | null {
  const password = env.AGENT_ADMIN_PASSWORD ?? "";
  const sessionSecret = env.AGENT_SESSION_SECRET ?? "";
  const workerSecret = env.SITE_AGENT_SECRET ?? "";
  if (password.length < 20 || sessionSecret.length < 32 || workerSecret.length < 32) return null;
  try {
    const url = new URL(env.SITE_AGENT_URL ?? "");
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (!(url.protocol === "https:" || (local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return { password, sessionSecret, workerSecret, workerUrl: url.origin, production: env.NODE_ENV === "production" };
  } catch { return null; }
}

const digest = (value: string) => createHash("sha256").update(value).digest();
export function passwordMatches(candidate: string, config: AgentConfig): boolean {
  return timingSafeEqual(digest(candidate), digest(config.password));
}

function sign(payload: string, config: AgentConfig): string {
  // Password rotation invalidates existing sessions as well as changing future logins.
  return createHmac("sha256", config.sessionSecret).update(digest(config.password)).update(payload).digest("base64url");
}

export function issueSession(config: AgentConfig, now = Date.now()): string {
  const issued = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, iat: issued, exp: issued + SESSION_SECONDS, nonce: randomBytes(24).toString("base64url") })).toString("base64url");
  return `${payload}.${sign(payload, config)}`;
}

export function verifySession(token: string, config: AgentConfig, now = Date.now()): boolean {
  if (token.length > 1024) return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return false;
  if (!timingSafeEqual(Buffer.from(parts[1]), Buffer.from(sign(parts[0], config)))) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const seconds = Math.floor(now / 1000);
    return payload.v === 1 && Number.isInteger(payload.iat) && Number.isInteger(payload.exp)
      && payload.iat <= seconds && payload.exp > seconds && payload.exp - payload.iat === SESSION_SECONDS
      && typeof payload.nonce === "string" && /^[A-Za-z0-9_-]{32}$/.test(payload.nonce);
  } catch { return false; }
}

const cookieName = (production: boolean) => production ? "__Host-site_agent_session" : "site_agent_session";
export function sessionToken(request: Request, config: AgentConfig): string {
  const name = cookieName(config.production);
  const cookies = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return cookies.length === 1 ? cookies[0].slice(name.length + 1) : "";
}

export function sessionCookie(token: string, production: boolean): string {
  return `${cookieName(production)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_SECONDS : 0}${production ? "; Secure" : ""}`;
}

export function requireSameOrigin(request: Request, env: Environment = process.env): void {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") throw new AgentHttpError(403, "仅允许本站发起操作");
  const requestUrl = new URL(request.url);
  const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  let expected = requestUrl.origin;
  // Vercel overwrites these headers at its trusted proxy. Do not trust arbitrary
  // forwarded headers in standalone deployments; there Request.url is canonical.
  if (env.VERCEL === "1") {
    const host = request.headers.get("x-forwarded-host");
    const protocol = request.headers.get("x-forwarded-proto");
    if (host && /^[a-z0-9.\-\[\]:]+$/i.test(host) && (protocol === "https" || protocol === "http")) expected = `${protocol}://${host}`;
  } else if (loopback(requestUrl.hostname)) {
    // Local reverse proxies and Next can normalize localhost/127.0.0.1/[::1]
    // differently. Match the browser Host only for loopback on the same port,
    // including when the local app is started with NODE_ENV=production.
    const host = request.headers.get("host");
    if (host && /^[a-z0-9.\-\[\]:]+$/i.test(host)) {
      try {
        const browserUrl = new URL(`${requestUrl.protocol}//${host}`);
        if (loopback(browserUrl.hostname) && browserUrl.port === requestUrl.port) expected = browserUrl.origin;
      } catch { /* Keep the canonical request origin when Host is invalid. */ }
    }
  }
  if (origin !== expected && !(loopback(requestUrl.hostname) && (() => {
    try {
      const candidate = new URL(origin);
      return candidate.protocol === requestUrl.protocol && loopback(candidate.hostname) && candidate.port === requestUrl.port;
    } catch { return false; }
  })())) throw new AgentHttpError(403, "仅允许本站发起操作");
}

export function clientKey(request: Request, env: Environment = process.env): string {
  // x-vercel-forwarded-for is platform-set; x-forwarded-for is user-spoofable.
  const ip = env.VERCEL === "1" ? request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() : undefined;
  return digest(ip && ip.length <= 128 ? ip : "shared").toString("hex");
}

type Bucket = { count: number; reset: number };
const buckets = new Map<string, Bucket>();
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): void {
  for (const [id, bucket] of buckets) if (bucket.reset <= now) buckets.delete(id);
  const existing = buckets.get(key);
  if (existing && existing.count >= limit) throw new AgentHttpError(429, "操作过于频繁，请稍后重试");
  // Bound memory even if many distinct authenticated sessions or IPs arrive.
  if (!existing && buckets.size >= 5000) throw new AgentHttpError(429, "操作过于频繁，请稍后重试");
  buckets.set(key, { count: (existing?.count ?? 0) + 1, reset: existing?.reset ?? now + windowMs });
}

export async function readBoundedBody(request: Request | Response, limit = BODY_LIMIT): Promise<string> {
  const announced = request.headers.get("content-length");
  if (announced && (!/^\d+$/.test(announced) || Number(announced) > limit)) throw new AgentHttpError(413, "请求内容过大");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AgentHttpError(413, "请求内容过大");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readAgentJson(request: Request, allowEmpty = false): Promise<unknown> {
  const text = await readBoundedBody(request);
  if (!text && allowEmpty) return {};
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new AgentHttpError(415, "请使用 JSON 请求");
  try { return JSON.parse(text); } catch { throw new AgentHttpError(400, "请求内容无效"); }
}
