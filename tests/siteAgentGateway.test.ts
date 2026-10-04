import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentHttpError, SESSION_SECONDS, agentConfig, issueSession, passwordMatches,
  rateLimit, readAgentJson, requireSameOrigin, sessionCookie, verifySession,
} from "../src/lib/siteAgent/auth";
import { forwardAgentRequest, handleAgentSession } from "../src/lib/siteAgent/gateway";

const origin = "https://workbench.example";
const password = "test-only-password-123456789";
const sessionSecret = "test-only-session-secret-123456789012345";
const workerSecret = "test-only-worker-secret-1234567890123456";
const fetchMock = vi.fn<typeof fetch>();
const sampleThread = {
  id: "thread-123", title: "Research", createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z",
  status: "idle", model: "gpt-example", effort: "high", mode: "research", archived: false,
  inputTokens: 0, outputTokens: 0, messages: [], activities: [], approvals: [], error: null,
};
function config() { return agentConfig()!; }
function request(path = "/status", method = "GET", body?: unknown, authenticated = true, extra: Record<string, string> = {}) {
  return new Request(`${origin}/api/agent${path}`, {
    method, headers: { origin, "content-type": "application/json", ...(authenticated ? { cookie: `__Host-site_agent_session=${issueSession(config())}` } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.stubEnv("AGENT_ADMIN_PASSWORD", password);
  vi.stubEnv("AGENT_SESSION_SECRET", sessionSecret);
  vi.stubEnv("SITE_AGENT_SECRET", workerSecret);
  vi.stubEnv("SITE_AGENT_URL", "https://worker.example");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("owner sessions", () => {
  it("fails closed for missing, short or unsafe configuration", () => {
    const valid = { AGENT_ADMIN_PASSWORD: password, AGENT_SESSION_SECRET: sessionSecret, SITE_AGENT_SECRET: workerSecret, SITE_AGENT_URL: "https://worker.example" };
    expect(agentConfig(valid)).not.toBeNull();
    for (const key of Object.keys(valid)) expect(agentConfig({ ...valid, [key]: "" })).toBeNull();
    for (const url of ["http://public.example", "https://worker.example/rpc", "https://user:pass@worker.example", "https://worker.example/?rpc=1", "ftp://worker.example"]) expect(agentConfig({ ...valid, SITE_AGENT_URL: url })).toBeNull();
    expect(agentConfig({ ...valid, SITE_AGENT_URL: "http://127.0.0.1:8787" })).not.toBeNull();
  });

  it("checks password content and rejects token tampering, expiration and rotation", () => {
    const current = config();
    const now = Date.now();
    const token = issueSession(current, now);
    expect(passwordMatches(password, current)).toBe(true);
    expect(passwordMatches(`${password}x`, current)).toBe(false);
    expect(verifySession(token, current, now)).toBe(true);
    expect(verifySession(token, current, now + SESSION_SECONDS * 1000)).toBe(false);
    expect(verifySession(token, current, now - 60_000)).toBe(false);
    const [payload, signature] = token.split(".");
    expect(verifySession(`${payload}.${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`, current)).toBe(false);
    expect(verifySession(`${payload}x.${signature}`, current)).toBe(false);
    expect(verifySession(token, { ...current, sessionSecret: "other-secret" })).toBe(false);
    expect(verifySession(token, { ...current, password: "other-password" })).toBe(false);
    for (const invalid of ["", "x", "a.b", `${token}.extra`, "x".repeat(2048)]) expect(verifySession(invalid, current)).toBe(false);
  });

  it("uses host-only secure HttpOnly expiring cookies in production", () => {
    expect(sessionCookie("token", true)).toBe(`__Host-site_agent_session=token; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}; Secure`);
    expect(sessionCookie("", true)).toContain("Max-Age=0; Secure");
    expect(sessionCookie("token", false)).toMatch(/^site_agent_session=/);
  });

  it("logs in, reads the session and clears the cookie on logout without caching", async () => {
    const loggedIn = await handleAgentSession(request("/session", "POST", { password }, false));
    expect(loggedIn.status).toBe(200);
    expect(await loggedIn.json()).toEqual({ authenticated: true, configured: true });
    const cookie = loggedIn.headers.get("set-cookie")!.split(";")[0];
    const status = await handleAgentSession(request("/session", "GET", undefined, false, { cookie }));
    expect(await status.json()).toEqual({ authenticated: true, configured: true });
    expect(status.headers.get("cache-control")).toContain("no-store");
    const logout = await handleAgentSession(request("/session", "DELETE", undefined, false, { cookie }));
    expect(await logout.json()).toEqual({ authenticated: false, configured: true });
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rejects bad passwords and ambiguous cookies", async () => {
    expect((await handleAgentSession(request("/session", "POST", { password: "incorrect" }, false))).status).toBe(401);
    const cookie = `__Host-site_agent_session=${issueSession(config())}`;
    const status = await handleAgentSession(request("/session", "GET", undefined, false, { cookie: `${cookie}; ${cookie}` }));
    expect(await status.json()).toEqual({ authenticated: false, configured: true });
  });

  it("reports disabled authentication and does not issue sessions without configuration", async () => {
    vi.stubEnv("AGENT_ADMIN_PASSWORD", "short");
    expect(await (await handleAgentSession(request("/session", "GET", undefined, false))).json()).toEqual({ authenticated: false, configured: false });
    expect((await handleAgentSession(request("/session", "POST", { password }, false))).status).toBe(503);
  });

  it("bounds login attempts per trusted client", async () => {
    vi.stubEnv("VERCEL", "1");
    for (let index = 0; index < 10; index++) {
      const response = await handleAgentSession(request("/session", "POST", { password: "incorrect" }, false, { "x-vercel-forwarded-for": "198.51.100.10" }));
      expect(response.status).toBe(401);
    }
    const blocked = await handleAgentSession(request("/session", "POST", { password }, false, { "x-vercel-forwarded-for": "198.51.100.10", "x-forwarded-for": "198.51.100.11" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("resets rate limits after the window expires", () => {
    rateLimit("test-window", 1, 1000, 100);
    expect(() => rateLimit("test-window", 1, 1000, 999)).toThrow(AgentHttpError);
    expect(() => rateLimit("test-window", 1, 1000, 1100)).not.toThrow();
  });
});

describe("same-origin and bounded input", () => {
  it("keeps mutations same-origin while allowing the password-only login request", async () => {
    const cases: Record<string, string>[] = [{ origin: "https://attacker.example" }, { origin: "null" }, { origin: "" }, { origin, "sec-fetch-site": "cross-site" }];
    for (const headers of cases) {
      expect((await forwardAgentRequest(request("/threads", "POST", {}, true, headers), "createThread")).status).toBe(403);
      expect((await handleAgentSession(request("/session", "POST", { password }, false, headers))).status).toBe(200);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts Vercel canonical forwarding only when running behind Vercel", () => {
    const proxied = new Request("http://internal:3000/api/agent/login", { headers: { origin, "x-forwarded-host": "workbench.example", "x-forwarded-proto": "https" } });
    expect(() => requireSameOrigin(proxied, {})).toThrow(AgentHttpError);
    expect(() => requireSameOrigin(proxied, { VERCEL: "1" })).not.toThrow();
    const attacker = new Request("http://internal:3000/api/agent/login", { headers: { origin: "https://attacker.example", "x-forwarded-host": "workbench.example", "x-forwarded-proto": "https" } });
    expect(() => requireSameOrigin(attacker, { VERCEL: "1" })).toThrow(AgentHttpError);
  });

  it("uses the browser loopback Host when Next dev normalizes Request.url to localhost", () => {
    const local = (origin: string, host = "127.0.0.1:3199") => new Request("http://localhost:3199/api/agent/session", { headers: { origin, host, "x-forwarded-host": "attacker.example", "sec-fetch-site": "same-origin" } });
    expect(() => requireSameOrigin(local("http://127.0.0.1:3199"), { NODE_ENV: "development" })).not.toThrow();
    expect(() => requireSameOrigin(local("http://[::1]:3199", "[::1]:3199"), { NODE_ENV: "development" })).not.toThrow();
    expect(() => requireSameOrigin(local("http://127.0.0.1:3199"), { NODE_ENV: "production" })).not.toThrow();
    for (const origin of ["https://attacker.example", "http://127.0.0.1:3200", "https://127.0.0.1:3199"]) expect(() => requireSameOrigin(local(origin), { NODE_ENV: "development" })).toThrow(AgentHttpError);
    expect(() => requireSameOrigin(local("http://127.0.0.1:3200", "127.0.0.1:3200"), { NODE_ENV: "development" })).toThrow(AgentHttpError);
    expect(() => requireSameOrigin(local("http://attacker.example", "attacker.example"), { NODE_ENV: "development" })).toThrow(AgentHttpError);
  });

  it("enforces actual streamed bytes even without content-length", async () => {
    const oversized = request("/threads/thread-123/messages", "POST", { text: "汉".repeat(12_000) });
    const response = await forwardAgentRequest(oversized, "message", { id: "thread-123" });
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects wrong content type and malformed JSON", async () => {
    await expect(readAgentJson(new Request(origin, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }))).rejects.toMatchObject({ status: 415 });
    await expect(readAgentJson(new Request(origin, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }))).rejects.toMatchObject({ status: 400 });
    await expect(readAgentJson(new Request(origin, { method: "POST", headers: { "content-type": "application/json", "content-length": "40000" }, body: "{}" }))).rejects.toMatchObject({ status: 413 });
  });
});

describe("controlled worker gateway", () => {
  it("accepts the explicit browser marker when an embedded browser omits Origin", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...sampleThread }, { status: 201 }));
    const requestWithoutOrigin = new Request(`${origin}/api/agent/threads`, {
      method: "POST", headers: { "content-type": "application/json", "x-site-agent-request": "1", cookie: `__Host-site_agent_session=${issueSession(config())}` },
      body: JSON.stringify({ title: "Embedded browser", mode: "research" }),
    });
    expect((await forwardAgentRequest(requestWithoutOrigin, "createThread")).status).toBe(201);
  });

  it("requires configuration and owner authentication before any worker request", async () => {
    expect((await forwardAgentRequest(request("/status", "GET", undefined, false), "status")).status).toBe(401);
    vi.stubEnv("SITE_AGENT_SECRET", "");
    expect((await forwardAgentRequest(request("/status", "GET", undefined, false), "status")).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only validated fields to a fixed authenticated URL and strips unknown output", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...sampleThread, secret: workerSecret, reasoning: "private analysis" }, { status: 201 }));
    const response = await forwardAgentRequest(request("/threads", "POST", { title: " My research ", mode: "research" }), "createThread");
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(sampleThread);
    expect(fetchMock).toHaveBeenCalledWith("https://worker.example/threads", expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "My research", mode: "research" }), cache: "no-store", redirect: "error", headers: { Authorization: `Bearer ${workerSecret}`, "Content-Type": "application/json", Accept: "application/json" } }));
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects RPC fields, unknown routes, traversal identifiers and unexpected query strings", async () => {
    const invalid = [
      forwardAgentRequest(request("/threads", "POST", { method: "command/exec", params: { command: "anything" } }), "createThread"),
      forwardAgentRequest(request("/threads", "POST", { cwd: "/etc" }), "createThread"),
      forwardAgentRequest(request("/threads/invalid", "GET"), "getThread", { id: "../status" }),
      forwardAgentRequest(request("/threads/invalid", "POST", { decision: "accept" }), "approval", { id: "thread-123", approvalId: "../../login" }),
      forwardAgentRequest(request("/status?url=https://elsewhere.example"), "status"),
      forwardAgentRequest(request("/status"), "command/exec" as "status"),
    ];
    expect((await Promise.all(invalid)).map(value => value.status)).toEqual([400, 400, 400, 400, 400, 404]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces request schemas and budget bounds", async () => {
    for (const body of [{ text: " " }, { text: "hello", sandbox: "none" }]) expect((await forwardAgentRequest(request("/threads/thread-123/messages", "POST", body), "message", { id: "thread-123" })).status).toBe(400);
    expect((await forwardAgentRequest(request("/threads/thread-123", "PATCH", {}), "patchThread", { id: "thread-123" })).status).toBe(400);
    expect((await forwardAgentRequest(request("/settings", "PUT", { dailyTurnLimit: 501, dailyTokenBudget: 0, maxTaskMinutes: 15 }), "settings")).status).toBe(400);
    expect((await forwardAgentRequest(request("/threads/thread-123/approvals/a", "POST", { decision: "always" }), "approval", { id: "thread-123", approvalId: "a" })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched HTTP methods and forwards only supported empty actions", async () => {
    expect((await forwardAgentRequest(request("/status", "POST", {}), "status")).status).toBe(405);
    fetchMock.mockResolvedValueOnce(Response.json({ status: "pending", code: "ABCD-EFGH", url: "https://auth.openai.com/codex/device" }));
    const response = await forwardAgentRequest(request("/login", "POST"), "login");
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://worker.example/login", expect.objectContaining({ body: "{}" }));
  });

  it("masks upstream errors, unavailable service and invalid response data", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: `private detail ${workerSecret}` }, { status: 500 }));
    const failure = await forwardAgentRequest(request("/status"), "status");
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain(workerSecret);
    fetchMock.mockRejectedValueOnce(new Error("private network error"));
    expect((await forwardAgentRequest(request("/status"), "status")).status).toBe(503);
    fetchMock.mockResolvedValueOnce(Response.json({ random: "unexpected" }));
    expect((await forwardAgentRequest(request("/status"), "status")).status).toBe(502);
    fetchMock.mockResolvedValueOnce(Response.json({ status: "pending", url: "javascript:alert(1)" }));
    expect((await forwardAgentRequest(request("/login", "POST", {}), "login")).status).toBe(502);
  });

  it("redacts configured secrets and raw errors even in otherwise valid output", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...sampleThread, error: "private /home/path stack trace", messages: [{ id: "m", role: "assistant", createdAt: "today", text: `${password} ${sessionSecret} ${workerSecret}` }] }));
    const response = await forwardAgentRequest(request("/threads/thread-123"), "getThread", { id: "thread-123" });
    expect(response.status).toBe(200);
    const text = await response.text();
    for (const privateValue of [password, sessionSecret, workerSecret, "/home/path"]) expect(text).not.toContain(privateValue);
    expect(text).toContain("已隐藏");
  });

  it("bounds successful upstream response size", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 1)));
    expect((await forwardAgentRequest(request("/threads"), "listThreads")).status).toBe(502);
  });
});
