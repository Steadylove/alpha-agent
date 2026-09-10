import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/telegram/webhook/route';
const relay = vi.hoisted(() => vi.fn());
vi.mock('@/lib/telegram/relay', () => ({ relayTelegramUpdate: relay }));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllGlobals());
const secret = 'a'.repeat(64);
const request = (body: string, token = secret) => new Request('https://site.test/api/telegram/webhook', {
  method: 'POST', headers: { 'x-telegram-bot-api-secret-token': token }, body,
});
it('未提供 Telegram 回调标识或消息无效时不进入服务', async () => {
  expect((await POST(request('{"update_id":1}', ''))).status).toBe(401);
  expect((await POST(request('{}'))).status).toBe(400);
  expect((await POST(request('not json'))).status).toBe(400);
  expect(relay).not.toHaveBeenCalled();
});
it('原始事件和回调密钥交给加密中转，仅在成功持久化后回复成功', async () => {
  const body = '{"update_id":1,"message":{"text":"/status"}}';
  relay.mockResolvedValue({ ok: true });
  expect((await POST(request(body))).status).toBe(200);
  expect(relay).toHaveBeenCalledWith(body, secret);
  relay.mockRejectedValue(new Error(`secret must not escape: ${secret}`));
  const response = await POST(request(body));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain(secret);
});
