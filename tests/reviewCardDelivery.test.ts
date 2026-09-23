import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DefiniteDeliveryError, deliverReviewCard, reviewDeliveryKey, postReviewDiscordImage } from "@/lib/notifications/reviewCardDelivery";

const dirs: string[] = [];
const stateFile = () => { const dir = mkdtempSync(path.join(tmpdir(), "review-cards-")); dirs.push(dir); return path.join(dir, "receipts.json"); };
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); vi.unstubAllGlobals(); });

it("逐图片、逐目标去重；失败补发不重发已经成功的频道", async () => {
  const file = stateFile(), sent = vi.fn(async () => "receipt1");
  const a = reviewDeliveryKey("2026-09-22", "tomorrow", "channel-a");
  const b = reviewDeliveryKey("2026-09-22", "tomorrow", "channel-b");
  await expect(deliverReviewCard(file, a, sent)).resolves.toBe("sent");
  await expect(deliverReviewCard(file, b, async () => { throw new DefiniteDeliveryError("429"); })).rejects.toThrow("429");
  await expect(deliverReviewCard(file, a, sent)).resolves.toBe("duplicate");
  await expect(deliverReviewCard(file, b, sent)).resolves.toBe("sent");
  expect(sent).toHaveBeenCalledTimes(2);
  expect(reviewDeliveryKey("2026-09-22", "options", "channel-a")).not.toBe(a);
  expect(reviewDeliveryKey("2026-09-23", "tomorrow", "channel-a")).not.toBe(a);
});
it("Discord 发送结果不确定时阻止重发；Telegram 使用相同幂等键允许恢复", async () => {
  const file = stateFile(), send = vi.fn(async () => "id");
  await expect(deliverReviewCard(file, "discord", async () => { throw new Error("timeout"); })).rejects.toThrow("timeout");
  await expect(deliverReviewCard(file, "discord", send)).rejects.toThrow("待核验");
  expect(send).not.toHaveBeenCalled();
  await expect(deliverReviewCard(file, "telegram", async () => { throw new Error("timeout"); }, true)).rejects.toThrow("timeout");
  await expect(deliverReviewCard(file, "telegram", send, true)).resolves.toBe("sent");
});
it("Discord 必须获得消息回执，429 可安全重试，网络超时不自动重试", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ id: "123" }), { status: 200 })).mockResolvedValueOnce(new Response("rate limited", { status: 429 })).mockRejectedValueOnce(new Error("network"));
  vi.stubGlobal("fetch", fetch);
  const image = { filename: "map.png", bytes: Buffer.from("image"), content: "review" };
  expect(await postReviewDiscordImage("https://discord.com/api/webhooks/1/test", image)).toBe("123");
  expect(String(fetch.mock.calls[0][0])).toContain("wait=true");
  await expect(postReviewDiscordImage("https://discord.com/api/webhooks/1/test", image)).rejects.toBeInstanceOf(DefiniteDeliveryError);
  await expect(postReviewDiscordImage("https://discord.com/api/webhooks/1/test", image)).rejects.toThrow("不确定");
  expect(fetch).toHaveBeenCalledTimes(3);
});
