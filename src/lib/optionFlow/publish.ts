import { postDiscordBotImage, postDiscordImage } from "@/lib/discord/sendWebhook";

import { discordBotToken } from "./discordFetch";
import { renderNoteworthyPng, renderSingleFlowPng } from "./cardImage";
import { shouldForward } from "./config";
import type { OptionFlowConfig, OptionFlowPost } from "./types";

/** Quill 服 #常规，账本 / GEX 现在就推这里。 */
export const DEFAULT_SIGNAL_CHANNEL_ID = "1530212207089160374";

export function signalWebhookUrl(): string {
  return (process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || "").trim();
}

export function signalChannelId(): string {
  return process.env.DISCORD_SIGNAL_CHANNEL_ID?.trim() || DEFAULT_SIGNAL_CHANNEL_ID;
}

export function shouldPublish(post: OptionFlowPost, cfg: OptionFlowConfig): boolean {
  return !post.publishedAt && shouldForward(post, cfg);
}

export async function renderOptionFlowPng(post: OptionFlowPost): Promise<Buffer> {
  if (post.kind === "noteworthy") return renderNoteworthyPng(post);
  return renderSingleFlowPng(post);
}

export async function publishOptionFlow(post: OptionFlowPost): Promise<void> {
  const filename = post.kind === "noteworthy" ? "option-flow-list.png" : "option-flow.png";
  const content = post.kind === "noteworthy" ? "期权流 · 确认名单" : "期权流 · 单笔";
  const bytes = await renderOptionFlowPng(post);
  const webhook = signalWebhookUrl();
  if (webhook) {
    await postDiscordImage(webhook, { filename, bytes, content });
    return;
  }
  await postDiscordBotImage(signalChannelId(), discordBotToken(), { filename, bytes, content });
}
