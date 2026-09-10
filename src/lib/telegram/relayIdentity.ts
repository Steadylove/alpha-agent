import { createHash } from "node:crypto";
import { CompactEncrypt, compactDecrypt, importSPKI, importPKCS8, createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { TELEGRAM_RELAY_PUBLIC_KEY } from "./relayPublicKey";

const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const teamIssuer = "https://oidc.vercel.com/steady1ove";
const issuers = new Map([teamIssuer, "https://oidc.vercel.com"].map((iss) => [iss, createRemoteJWKSet(new URL(`${iss}/.well-known/jwks`))]));

export async function sealRelayIdentity(token: string, body = "", now = Date.now(), publicKey = TELEGRAM_RELAY_PUBLIC_KEY, sourceSecret?: string) {
  const key = await importSPKI(publicKey, "RSA-OAEP-256");
  const envelope = Buffer.from(JSON.stringify({ token, digest: digest(body), time: now, sourceSecret }));
  // 使用标准 JWE 加密短期服务凭据，避免它经过现有 HTTP 行情代理时明文暴露。
  return new CompactEncrypt(envelope).setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256GCM" }).encrypt(key);
}

export async function verifyVercelIdentity(token: string) {
  const iss = decodeJwt(token).iss;
  const jwks = iss ? issuers.get(iss) : undefined;
  if (!jwks) throw new Error("Untrusted issuer");
  await jwtVerify(token, jwks, {
    issuer: iss, audience: "https://vercel.com/steady1ove",
    subject: "owner:steady1ove:project:alpha-agent:environment:production",
    algorithms: ["RS256"], requiredClaims: ["exp", "iat", "iss", "aud", "sub"],
  });
}

export async function openRelayIdentity(privateKey: string, identity: string, body: string, now = Date.now(), verifyToken = verifyVercelIdentity): Promise<{ sourceSecret?: string } | null> {
  if (!privateKey || !identity || identity.length > 16000) return null;
  try {
    const key = await importPKCS8(privateKey, "RSA-OAEP-256");
    const { plaintext } = await compactDecrypt(identity, key, { keyManagementAlgorithms: ["RSA-OAEP-256"], contentEncryptionAlgorithms: ["A256GCM"] });
    const value = JSON.parse(Buffer.from(plaintext).toString("utf8")) as { token?: unknown; digest?: unknown; time?: unknown; sourceSecret?: string };
    if (typeof value.token !== "string" || typeof value.time !== "number" || Math.abs(now - value.time) > 300_000 || value.digest !== digest(body)) return null;
    await verifyToken(value.token);
    return { sourceSecret: typeof value.sourceSecret === "string" ? value.sourceSecret : undefined };
  } catch { return null; }
}

export async function verifyRelayIdentity(privateKey: string, identity: string, body: string, now = Date.now(), verifyToken = verifyVercelIdentity) {
  return !!await openRelayIdentity(privateKey, identity, body, now, verifyToken);
}
