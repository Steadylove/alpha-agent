import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayHeaders, verifyRelay } from "@/lib/telegram/relayAuth";
import { TelegramStore } from "@/lib/telegram/store";
import { createTelegramRelayServer } from "@/lib/telegram/relayServer";
import { enqueueTelegramImage } from "@/lib/telegram/relay";
import { TelegramClient, TelegramError } from "@/lib/telegram/client";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

it("签名拒绝缺失、错误密钥、篡改、过期请求", () => {
  const time = 1_800_000_000_000, body = '{"test":true}', h = relayHeaders("secret", body, time);
  expect(verifyRelay("secret", h['x-relay-time'], h['x-relay-signature'], body, time)).toBe(true);
  expect(verifyRelay("other", h['x-relay-time'], h['x-relay-signature'], body, time)).toBe(false);
  expect(verifyRelay("secret", h['x-relay-time'], h['x-relay-signature'], body + " ", time)).toBe(false);
  expect(verifyRelay("secret", h['x-relay-time'], h['x-relay-signature'], body, time + 300001)).toBe(false);
  expect(verifyRelay("", "", "", "", time)).toBe(false);
});

it("真实 HTTP 入队需签名；响应前持久化，重复提交保持已发送进度，重启可恢复", async () => {
  const dir = mkdtempSync(`${tmpdir()}/telegram-http-`), store = new TelegramStore(dir);
  let ready = true;
  const server = createTelegramRelayServer(store, "test-secret", true, () => ({ ok: ready, username: "ExampleBot" }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const id = createHash("sha256").update("one signal").digest("hex");
    const body = JSON.stringify({ id, content: "signal", png: png.toString('base64') });
    const post = (raw: string) => fetch(`${base}/enqueue`, { method: 'POST', headers: relayHeaders('test-secret', raw), body: raw });
    expect((await fetch(`${base}/enqueue`, { method: 'POST', body })).status).toBe(401);
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect((await post('{}')).status).toBe(400);
    ready = false; expect((await post(body)).status).toBe(503); ready = true;
    expect(await (await post(body)).json()).toMatchObject({ ok: true, recipients: 0, duplicate: false });
    expect(new TelegramStore(dir).jobs.get(id)!.deliveries).toEqual([]);
    store.state.groups['-1'] = { id: '-1', title: 'private group name', present: true, writable: true, paused: false, updatedAt: 0, nextSendAt: 0, messageThreadId: 16 }; store.saveState();
    expect(await (await post(body)).json()).toMatchObject({ ok: true, recipients: 1, duplicate: false });
    expect(new TelegramStore(dir).jobs.get(id)!.deliveries[0]).toMatchObject({ state: 'pending', messageThreadId: 16 });
    const job = store.jobs.get(id)!; job.deliveries[0].state = 'sent'; store.saveJob(job);
    expect(await (await post(body)).json()).toMatchObject({ duplicate: true });
    expect(new TelegramStore(dir).jobs.get(id)!.deliveries[0].state).toBe('sent');
    const status = await (await fetch(`${base}/status`, { headers: relayHeaders('test-secret') })).json();
    expect(status).toMatchObject({ ok: true, sent: 1 });
    expect(JSON.stringify(status)).not.toContain('private group name');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

describe("Telegram 发送适配", () => {
  it("同一事件保持幂等 ID、复用原 PNG，说明文字去掉 Discord 粗体", async () => {
    vi.stubEnv('TELEGRAM_RELAY_URL', 'https://relay.example/telegram'); vi.stubEnv('TELEGRAM_RELAY_SECRET', 'test');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}')); vi.stubGlobal('fetch', fetchMock);
    const input = { filename: 'book.png', bytes: png, content: '**现金账本**', eventKey: 'book:4h:2026-09-09' };
    await enqueueTelegramImage(input);
    fetchMock.mockResolvedValue(new Response('{"ok":true}'));
    await enqueueTelegramImage({ ...input, bytes: Buffer.concat([png, Buffer.from('different renderer')]) });
    const first = JSON.parse(fetchMock.mock.calls[0][1].body), second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(first.id).toBe(second.id); expect(first.content).toBe('现金账本'); expect(Buffer.from(first.png, 'base64')).toEqual(png);
  });
  it("超时与 API 异常不将 Token 写入错误，保留重试和群迁移信息", async () => {
    const client = new TelegramClient('sensitive-token');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('https://api.telegram.org/botsensitive-token')));
    await expect(client.call('getMe')).rejects.toThrow('Telegram API error 0');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 9, migrate_to_chat_id: -100 } }), { status: 429 })));
    await expect(client.call('sendMessage')).rejects.toMatchObject({ code: 429, retryAfter: 9, migrateTo: -100 });
    expect(new TelegramError(500).message).not.toContain('sensitive-token');
  });
});
