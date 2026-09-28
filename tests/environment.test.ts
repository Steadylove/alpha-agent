import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { readEnvironment, environmentReport } from "../scripts/env";
import { createRuntimeConfigLoader, sealRuntimeConfig, webSecrets } from "../src/lib/runtimeConfig";
import { sealRelayIdentity } from "../src/lib/telegram/relayIdentity";
import { createTelegramRelayServer } from "../src/lib/telegram/relayServer";
import { relayHeaders } from "../src/lib/telegram/relayAuth";
import { TelegramStore } from "../src/lib/telegram/store";

describe("统一环境配置", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(path.join(tmpdir(), "alpha-env-")); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });
  const file = (name: string, text: string) => writeFileSync(path.join(cwd, name), text);

  it("与 Next 文件优先级一致，保留进程注入的空 URL", () => {
    file(".env", 'MARKET_DATA_BASE_URL=https://base.test\nALPACA_API_KEY=base\n');
    file(".env.production", 'ALPACA_API_KEY=production\n');
    file(".env.local", 'ALPACA_API_KEY=local\n');
    file(".env.production.local", 'ALPACA_API_KEY=production-local\n');
    const input = { NODE_ENV: "production", MARKET_DATA_BASE_URL: "" };
    const result = readEnvironment({ cwd, env: input });
    expect(result.values.MARKET_DATA_BASE_URL).toBe("");
    expect(result.values.ALPACA_API_KEY).toBe("production-local");
    expect(result.origins.ALPACA_API_KEY).toBe(".env.production.local");
    expect(result.conflicts).toEqual(["ALPACA_API_KEY"]);
    expect(input).toEqual({ NODE_ENV: "production", MARKET_DATA_BASE_URL: "" });
  });

  it("test 模式不加载本机覆盖，也不读取 Vercel 导出的快照", () => {
    file(".env", "ALPACA_API_KEY=base\n");
    file(".env.local", "ALPACA_API_KEY=private-local\n");
    file(".env.vercel.local", "VERCEL=1\n");
    const result = readEnvironment({ cwd, env: { NODE_ENV: "test" } });
    expect(result.values.ALPACA_API_KEY).toBe("base");
    expect(result.values.VERCEL).toBeUndefined();
  });

  it("指定文件时隔离默认文件，仍由已注入变量优先", () => {
    file(".env", "DISCORD_BOT_TOKEN=wrong-bot\n");
    file("service.env", 'CRON_SECRET="line1\nline2"\n');
    const result = readEnvironment({ cwd, env: { DOTENV_CONFIG_PATH: "service.env", CRON_SECRET: "injected" } });
    expect(result.values.CRON_SECRET).toBe("injected");
    expect(result.values.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(result.files).toEqual(["service.env"]);
  });

  it("有效值、错误值、退役项和重复项均只输出名称与状态", () => {
    const secret = "never-expose-this-value";
    file(".env", `ALPACA_API_KEY=${secret}\nALPACA_API_SECRET=${secret}\nDATABASE_URL=${secret}\nALPACA_MAX_INFLIGHT=${secret}\n`);
    file(".env.local", "ALPACA_API_KEY=another-private-value\n");
    const report = environmentReport(readEnvironment({ cwd, env: {} }), "daily");
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("another-private-value");
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "DATABASE_URL", code: "retired" }),
      expect.objectContaining({ key: "ALPACA_MAX_INFLIGHT", code: "invalid" }),
    ]));
    expect(report.duplicates).toEqual([expect.objectContaining({ key: "ALPACA_API_KEY", different: true })]);
  });

  it("检查必填和数值边界，并保留对旧别名的识别", () => {
    file(".env", "APCA_API_KEY_ID=alias\nOPTION_FLOW_MIN_PREMIUM_USD=-1\nALPACA_MAX_INFLIGHT=0\n");
    const input = readEnvironment({ cwd, env: {} });
    expect(environmentReport(input, "daily").issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "ALPACA_API_KEY", code: "missing" }),
      expect.objectContaining({ key: "ALPACA_API_SECRET", code: "missing" }),
      expect.objectContaining({ key: "ALPACA_MAX_INFLIGHT", code: "invalid" }),
    ]));
    expect(environmentReport(input).issues).toContainEqual(expect.objectContaining({ key: "OPTION_FLOW_MIN_PREMIUM_USD", code: "invalid" }));
    expect(environmentReport(input).issues.some(i => i.key === "APCA_API_KEY_ID")).toBe(false);
  });
});

// Private config crosses the existing HTTP relay encrypted in both directions.
// These tests never use real service credentials or call message delivery APIs.
describe("VPS 私有配置", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("拒绝越界变量和空鉴权，防止修改 Node 参数或意外关闭接口保护", () => {
    expect(() => webSecrets({ CRON_SECRET: "" })).toThrow();
    expect(() => webSecrets({ CRON_SECRET: "test", NODE_OPTIONS: "unexpected" })).toThrow();
    expect(() => webSecrets({ CRON_SECRET: "test", FMP_API_KEY: 12 })).toThrow();
    expect(webSecrets({ CRON_SECRET: "test", FMP_API_KEY: "" })).toEqual({ CRON_SECRET: "test", FMP_API_KEY: "" });
  });

  it("只在生产请求读取，合并并发，缓存到期重读，清除已撤销值", async () => {
    let time = Date.now(), values = { CRON_SECRET: "private-v1", FMP_API_KEY: "old" } as Record<string, string>;
    const env = { VERCEL: "1", VERCEL_ENV: "production", DEEPSEEK_API_KEY: "old-dashboard-value" } as Record<string, string | undefined>;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(await sealRuntimeConfig(String(init?.body), (init?.headers as Record<string,string>)["x-relay-identity"], values, time)));
    const load = createRuntimeConfigLoader({ env, now: () => time, fetcher, identity: async (_body, key) => key });
    await Promise.all([load(), load(), load()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(env.CRON_SECRET).toBe("private-v1");
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    await load(); expect(fetcher).toHaveBeenCalledTimes(1);
    values = { CRON_SECRET: "private-v2" }; time += 300_001;
    await load(); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(env.CRON_SECRET).toBe("private-v2"); expect(env.FMP_API_KEY).toBeUndefined();
    env.VERCEL_ENV = "preview"; time += 300_001;
    await load(); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("失败时阻止请求继续，不泄漏上游错误或部分更新；下次请求可以重试", async () => {
    const env = { VERCEL: "1", VERCEL_ENV: "production", CRON_SECRET: "previous" } as Record<string, string | undefined>;
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("sensitive-upstream-value")).mockResolvedValueOnce(new Response("tampered-response"));
    const load = createRuntimeConfigLoader({ env, fetcher, identity: async () => "identity" });
    await expect(load()).rejects.toThrow("VPS 私有配置读取失败");
    await expect(load()).rejects.toThrow("VPS 私有配置读取失败");
    expect(fetcher).toHaveBeenCalledTimes(2); expect(env.CRON_SECRET).toBe("previous");
  });

  it("过期响应拒绝使用，文件故障不回落到旧 Vercel 密钥", async () => {
    const env = { VERCEL: "1", VERCEL_ENV: "production", CRON_SECRET: "old" } as Record<string, string | undefined>;
    const now = Date.now();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(await sealRuntimeConfig(String(init?.body), (init?.headers as Record<string,string>)["x-relay-identity"], { CRON_SECRET: "new" }, now - 120_000)));
    const load = createRuntimeConfigLoader({ env, now: () => now, fetcher, identity: async (_body, key) => key });
    await expect(load()).rejects.toThrow("VPS 私有配置读取失败");
    expect(env.CRON_SECRET).toBe("old");
  });

  it("真实 HTTP 只接受本项目生产 JWT；普通签名、预览和其他项目均不可取密钥", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "alpha-private-config-"));
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const pair = await generateKeyPair("RS256"), jwk = { ...await exportJWK(pair.publicKey), kid: "config-test", alg: "RS256" };
    const actualFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => String(url).includes("/.well-known/jwks")
      ? new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } }) : actualFetch(url, init)));
    const values = { CRON_SECRET: "real-test-secret", DISCORD_WEBHOOK_URL: "private-webhook" };
    const provider = vi.fn(() => values);
    const server = createTelegramRelayServer(new TelegramStore(dir), "relay-test", true, () => ({ ok: true }), rsa.privateKey, undefined, provider);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/runtime-config`;
    const token = (subject: string) => new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "config-test" })
      .setIssuer("https://oidc.vercel.com/steady1ove").setAudience("https://vercel.com/steady1ove").setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(pair.privateKey);
    const subject = "owner:steady1ove:project:alpha-agent:environment:production";
    try {
      expect((await actualFetch(url, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await actualFetch(url, { method: "POST", body: "{}", headers: relayHeaders("relay-test", "{}") })).status).toBe(401);
      for (const sub of [subject.replace("production", "preview"), subject.replace("alpha-agent", "other")]) {
        const identity = await sealRelayIdentity(await token(sub), "{}", undefined, rsa.publicKey, "x".repeat(43));
        expect((await actualFetch(url, { method: "POST", body: "{}", headers: { "x-relay-identity": identity } })).status).toBe(401);
      }
      expect(provider).not.toHaveBeenCalled();
      const env = { VERCEL: "1", VERCEL_ENV: "production" } as Record<string, string | undefined>;
      const load = createRuntimeConfigLoader({ env,
        identity: async (body, key) => sealRelayIdentity(await token(subject), body, undefined, rsa.publicKey, key),
        fetcher: async (_url, init) => {
          const result = await actualFetch(url, init);
          expect(result.headers.get("cache-control")).toBe("no-store");
          expect(result.headers.get("content-type")).toBe("application/jose");
          const wire = await result.clone().text();
          expect(wire).not.toContain(values.CRON_SECRET); expect(wire).not.toContain(values.DISCORD_WEBHOOK_URL);
          return result;
        },
      });
      await load(); expect(env.CRON_SECRET).toBe(values.CRON_SECRET); expect(provider).toHaveBeenCalledOnce();
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
  });
});
