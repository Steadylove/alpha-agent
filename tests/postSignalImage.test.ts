import { beforeEach, expect, it, vi } from "vitest";
import { postSignalImage } from "@/lib/notifications/postSignalImage";
const mocks = vi.hoisted(() => ({ discord: vi.fn(), telegram: vi.fn() }));
vi.mock('@/lib/discord/sendWebhook', () => ({ postDiscordImage: mocks.discord }));
vi.mock('@/lib/telegram/relay', () => ({ enqueueTelegramImage: mocks.telegram }));
beforeEach(() => vi.resetAllMocks());
const input = { filename: 'signal.png', bytes: Buffer.from('image'), content: 'signal', eventKey: 'test-event' };

it("两个平台使用同一张图和说明", async () => {
  await postSignalImage('discord-hook', input);
  expect(mocks.discord).toHaveBeenCalledWith('discord-hook', input);
  expect(mocks.telegram).toHaveBeenCalledWith(input);
});
it.each(['discord', 'telegram'] as const)("%s 失败仍执行另一平台，同时明确报告失败", async (failed) => {
  mocks[failed].mockRejectedValue(new Error('unavailable'));
  await expect(postSignalImage('discord-hook', input)).rejects.toThrow('unavailable');
  expect(mocks.discord).toHaveBeenCalledTimes(1); expect(mocks.telegram).toHaveBeenCalledTimes(1);
});
