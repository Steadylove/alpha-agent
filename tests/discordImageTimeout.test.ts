import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { postDiscordImage } from "@/lib/discord/sendWebhook";

const fetcher = vi.fn();
const input = { filename: "image.png", bytes: Buffer.from("image") };
beforeEach(() => { vi.resetAllMocks(); vi.useFakeTimers(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("Discord 图片每次请求设15秒上限", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  fetcher.mockResolvedValue(new Response(null, { status: 204 }));
  await postDiscordImage("https://discord.com/api/webhooks/1/test", input);
  expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  expect(timeout).toHaveBeenCalledWith(15_000);
});

it.each(["TimeoutError", "AbortError"])("%s 后投递结果不确定，不自动重发", async (name) => {
  fetcher.mockRejectedValue(new DOMException("delivery uncertain", name));
  const pending = postDiscordImage("https://discord.com/api/webhooks/1/test", input).catch((error: Error) => error);
  await vi.runAllTimersAsync();
  expect((await pending as Error).name).toBe(name);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("保留现有HTTP失败重试，成功后不再重发", async () => {
  fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const pending = postDiscordImage("https://discord.com/api/webhooks/1/test", input);
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
