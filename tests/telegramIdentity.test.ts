import { generateKeyPairSync } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";
import { sealRelayIdentity, openRelayIdentity, verifyRelayIdentity, verifyVercelIdentity } from "@/lib/telegram/relayIdentity";

const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
afterEach(() => vi.unstubAllGlobals());

it('服务身份通过 JWE 加密并绑定请求正文，拒绝篡改、过期和无效身份', async () => {
  const now = 1_800_000_000_000, body = 'signal image';
  const sealed = await sealRelayIdentity('short-lived-private-token', body, now, keys.publicKey);
  expect(sealed).not.toContain('short-lived-private-token');
  const verify = vi.fn().mockResolvedValue(undefined);
  expect(await verifyRelayIdentity(keys.privateKey, sealed, body, now, verify)).toBe(true);
  expect(verify).toHaveBeenCalledWith('short-lived-private-token');
  expect(await verifyRelayIdentity(keys.privateKey, sealed, body + 'x', now, verify)).toBe(false);
  expect(await verifyRelayIdentity(keys.privateKey, sealed, body, now + 300001, verify)).toBe(false);
  expect(await verifyRelayIdentity(keys.privateKey, sealed.slice(5), body, now, verify)).toBe(false);
  verify.mockRejectedValue(new Error('invalid issuer'));
  expect(await verifyRelayIdentity(keys.privateKey, sealed, body, now, verify)).toBe(false);
});

it('Telegram 回调密钥只在加密身份内部传输', async () => {
  const hookSecret = 'a'.repeat(64), now = 1_800_000_000_000;
  const sealed = await sealRelayIdentity('service-token', 'update', now, keys.publicKey, hookSecret);
  expect(sealed).not.toContain(hookSecret);
  expect(await openRelayIdentity(keys.privateKey, sealed, 'update', now, async () => {})).toEqual({ sourceSecret: hookSecret });
});

it('真实 JWT 校验只接受指定项目的生产身份，拒绝其他项目、预览、过期和伪造签名', async () => {
  const pair = await generateKeyPair('RS256'), attacker = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'test-key', alg: 'RS256' };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } })));
  const issuer = 'https://oidc.vercel.com/steady1ove', aud = 'https://vercel.com/steady1ove';
  const sub = 'owner:steady1ove:project:alpha-agent:environment:production';
  const token = (subject = sub, iss = issuer, exp: number | string = '5m', privateKey = pair.privateKey) =>
    new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(iss).setAudience(aud).setSubject(subject).setIssuedAt().setExpirationTime(exp).sign(privateKey);
  await expect(verifyVercelIdentity(await token())).resolves.toBeUndefined();
  await expect(verifyVercelIdentity(await token(sub.replace('alpha-agent', 'other-app')))).rejects.toThrow();
  await expect(verifyVercelIdentity(await token(sub.replace('production', 'preview')))).rejects.toThrow();
  await expect(verifyVercelIdentity(await token(sub, 'https://attacker.example'))).rejects.toThrow();
  await expect(verifyVercelIdentity(await token(sub, issuer, 1))).rejects.toThrow();
  await expect(verifyVercelIdentity(await token(sub, issuer, '5m', attacker.privateKey))).rejects.toThrow();
});
