import { randomBytes } from "node:crypto";
import { CompactEncrypt, compactDecrypt } from "jose";
import { appConfig, WEB_SECRET_KEYS } from "../../app.config";
import { sealRelayIdentity } from "./telegram/relayIdentity";

type Secrets = Partial<Record<(typeof WEB_SECRET_KEYS)[number], string>>;
const allowedKeys = new Set<string>(WEB_SECRET_KEYS);
const purpose = "web-runtime-config";

/** Validate the complete response before touching process.env. Never accept arbitrary env keys. */
export function webSecrets(value: unknown): Secrets {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime configuration");
  const entries = Object.entries(value);
  if (entries.some(([key, val]) => !allowedKeys.has(key) || typeof val !== "string" || val.length > 16384)) {
    throw new Error("Invalid runtime configuration");
  }
  const secrets = Object.fromEntries(entries) as Secrets;
  if (!secrets.CRON_SECRET?.trim()) throw new Error("Missing runtime authentication");
  return secrets;
}

/** Response key travels only inside the RSA-encrypted, OIDC-authenticated request identity. */
export async function sealRuntimeConfig(body: string, responseKey: string, values: unknown, now = Date.now()) {
  const request = JSON.parse(body);
  if (request?.purpose !== purpose || !/^[a-f0-9]{64}$/.test(request?.nonce ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(responseKey)) {
    throw new Error("Invalid configuration request");
  }
  const plaintext = Buffer.from(JSON.stringify({ nonce: request.nonce, expiresAt: now + 60_000, variables: webSecrets(values) }));
  return new CompactEncrypt(plaintext).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).encrypt(Buffer.from(responseKey, "base64url"));
}

export function createRuntimeConfigLoader(options: {
  env?: Record<string, string | undefined>;
  now?: () => number;
  fetcher?: typeof fetch;
  identity?: (body: string, responseKey: string) => Promise<string>;
} = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  let expiresAt = 0;
  let pending: Promise<void> | undefined;
  return async function load() {
    // Vercel platform identity stays platform-provided; no business secret is needed to bootstrap.
    if (!env.VERCEL || env.VERCEL_ENV !== appConfig.vercelIdentity.environment) return;
    if (now() < expiresAt) return;
    if (pending) return pending;
    pending = (async () => {
      try {
        const responseKey = randomBytes(32), nonce = randomBytes(32).toString("hex");
        const body = JSON.stringify({ purpose, nonce });
        const identity = options.identity ?? (async (payload: string, key: string) => {
          const { getVercelOidcToken } = await import("@vercel/oidc");
          return sealRelayIdentity(await getVercelOidcToken(), payload, undefined, undefined, key);
        });
        const response = await (options.fetcher ?? fetch)(`${appConfig.marketDataUrl}${appConfig.runtimeConfig.path}`, {
          method: "POST", cache: "no-store", redirect: "error", body,
          headers: { "content-type": "application/json", "x-relay-identity": await identity(body, responseKey.toString("base64url")) },
          signal: AbortSignal.timeout(appConfig.runtimeConfig.timeoutMs),
        });
        if (!response.ok) throw new Error("Configuration service unavailable");
        const encrypted = await response.text();
        if (encrypted.length > 262144) throw new Error("Invalid configuration response");
        const { plaintext } = await compactDecrypt(encrypted, responseKey, { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
        const result = JSON.parse(Buffer.from(plaintext).toString("utf8"));
        if (result.nonce !== nonce || !Number.isFinite(result.expiresAt) || result.expiresAt < now() || result.expiresAt > now() + 120_000) {
          throw new Error("Invalid configuration response");
        }
        const values = webSecrets(result.variables);
        for (const key of WEB_SECRET_KEYS) {
          if (values[key] === undefined) delete env[key];
          else env[key] = values[key];
        }
        expiresAt = now() + appConfig.runtimeConfig.cacheMs;
      } catch {
        // Includes upstream/parse/crypto errors: don't log secrets, identities or response bodies.
        throw new Error("VPS 私有配置读取失败，请检查配置服务");
      } finally { pending = undefined; }
    })();
    return pending;
  };
}

export const loadRuntimeConfig = createRuntimeConfigLoader();
