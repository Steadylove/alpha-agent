import { postDiscordImage } from "@/lib/discord/sendWebhook";
import { enqueueTelegramImage } from "@/lib/telegram/relay";

/** 两个平台独立执行；Telegram 在 VPS 持久化入队后异步投递到每个群。 */
export async function postSignalImage(webhook: string, input: {
  filename: string; bytes: Buffer; content?: string; eventKey?: string;
}) {
  const results = await Promise.allSettled([postDiscordImage(webhook, input), enqueueTelegramImage(input)]);
  const errors = results.flatMap((r, i) => r.status === "rejected" ? [`${i ? "Telegram" : "Discord"}: ${r.reason instanceof Error ? r.reason.message : "推送失败"}`] : []);
  if (errors.length) throw new Error(errors.join("; "));
}
