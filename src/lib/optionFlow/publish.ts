import { postDiscordBotImage } from "@/lib/discord/sendWebhook";

import { discordBotToken } from "./discordFetch";
import { renderGexFlowPng, renderNoteworthyPng, renderSingleFlowPng } from "./cardImage";
import { isOptionSessionPosted, shouldForward } from "./config";
import { hasPublishedTweet } from "./store";
import type { OptionFlowConfig, OptionFlowPost } from "./types";
import { postSignalImage } from "@/lib/notifications/postSignalImage";

/** Quill 服 #常规，账本 / GEX 现在就推这里。 */
export const DEFAULT_SIGNAL_CHANNEL_ID = "1530212207089160374";
/** 单笔走网站 postSignalImage，和买卖卡同一条 Discord + Telegram 路径。 */
const DEFAULT_FLOW_PUSH = "https://alpha-agent-eight.vercel.app/api/tv/render-option-flow";

export function signalWebhookUrl(): string {
  return (process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || "").trim();
}

export function signalChannelId(): string {
  return process.env.DISCORD_SIGNAL_CHANNEL_ID?.trim() || DEFAULT_SIGNAL_CHANNEL_ID;
}

export function shouldPublish(post: OptionFlowPost, cfg: OptionFlowConfig, known: readonly OptionFlowPost[] = []): boolean {
  return !post.publishedAt && !hasPublishedTweet(known, post.tweetId) && shouldForward(post, cfg) && isOptionSessionPosted(post.postedAt);
}

export async function renderOptionFlowPng(post: OptionFlowPost): Promise<Buffer> {
  if (post.kind === "noteworthy") return renderNoteworthyPng(post);
  if (post.kind === "gex") return renderGexFlowPng(post);
  return renderSingleFlowPng(post);
}

export function optionFlowPushUrl(): string {
  return (process.env.OPTION_FLOW_PUSH_URL || DEFAULT_FLOW_PUSH).trim();
}

export async function publishOptionFlow(post: OptionFlowPost): Promise<void> {
  const filename = post.kind === "noteworthy" ? "option-flow-list.png" : post.kind === "gex" ? "option-flow-gex.png" : "option-flow.png";
  const content = post.kind === "noteworthy" ? "期权流 · 确认名单" : post.kind === "gex" ? "期权流 · 热力图" : "期权流 · 单笔";
  const bytes = await renderOptionFlowPng(post);
  if (post.kind === "flow") {
    const res = await fetch(optionFlowPushUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename,
        content,
        eventKey: `option-flow:${post.tweetId || post.id}`,
        png: bytes.toString("base64"),
      }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error((await res.text()).trim() || `期权流推送失败 HTTP ${res.status}`);
    return;
  }
  const kind = post.kind === "noteworthy" ? "option-flow-noteworthy" as const : "option-flow-gex" as const;
  const webhook = signalWebhookUrl();
  if (webhook || !process.env.DISCORD_BOT_TOKEN?.trim()) {
    await postSignalImage(webhook, {
      kind,
      filename,
      bytes,
      content,
      eventKey: `option-flow:${post.tweetId || post.id}`,
    });
    return;
  }
  await postDiscordBotImage(signalChannelId(), discordBotToken(), { filename, bytes, content });
}
