import { extractCard } from "./extract";
import type { OptionFlowPost } from "./types";

export type DiscordEmbedLike = {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  author?: { name?: string | null } | null;
  footer?: { text?: string | null } | null;
  image?: { url?: string | null; proxy_url?: string | null } | null;
  thumbnail?: { url?: string | null; proxy_url?: string | null } | null;
  fields?: Array<{ name?: string | null; value?: string | null }> | null;
};

export type DiscordMessageLike = {
  id: string;
  timestamp?: string;
  content?: string | null;
  author?: { username?: string | null; bot?: boolean | null } | null;
  webhook_id?: string | null;
  embeds?: DiscordEmbedLike[] | null;
  attachments?: Array<{ url?: string | null }> | null;
};

const CRYPTO_FIELD = /token detected/i;

function handleOf(name?: string | null): string | undefined {
  const m = name?.match(/@([A-Za-z0-9_]+)/);
  return m?.[1];
}

function tweetOf(url?: string | null): { tweetUrl?: string; tweetId?: string } {
  if (!url) return {};
  const m = url.match(/https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
  return m ? { tweetUrl: url, tweetId: m[1] } : url.includes("x.com") || url.includes("twitter.com") ? { tweetUrl: url } : {};
}

export function relayText(message: DiscordMessageLike): string {
  const parts: string[] = [];
  if (message.content?.trim()) parts.push(message.content.trim());
  for (const embed of message.embeds ?? []) {
    if (embed.description?.trim()) parts.push(embed.description.trim());
    else if (embed.title?.trim()) parts.push(embed.title.trim());
  }
  return parts.join("\n");
}

export function isRelayPost(message: DiscordMessageLike): boolean {
  if (message.author?.username === "X-Relay" || message.webhook_id) {
    return Boolean(relayText(message) || (message.embeds ?? []).some((e) => e.url));
  }
  return (message.embeds ?? []).some((e) => /x\.com|twitter\.com/i.test(e.url ?? ""));
}

export function parseRelayMessage(message: DiscordMessageLike, now = new Date()): OptionFlowPost | null {
  if (!isRelayPost(message)) return null;
  const embed = (message.embeds ?? [])[0];
  const rawText = relayText(message);
  const card = extractCard(rawText);
  const images = [
    ...(message.embeds ?? []).flatMap((e) => [e.image?.url, e.thumbnail?.url]),
    ...(message.attachments ?? []).map((a) => a.url),
  ].filter((url): url is string => Boolean(url));
  const proxies = (message.embeds ?? [])
    .flatMap((e) => [e.image?.proxy_url, e.thumbnail?.proxy_url])
    .filter((url): url is string => Boolean(url));
  const tweet = tweetOf(embed?.url);
  return {
    id: message.id,
    postedAt: message.timestamp || now.toISOString(),
    ingestedAt: now.toISOString(),
    ...tweet,
    handle: handleOf(embed?.author?.name),
    kind: card.kind,
    thesis: card.thesis,
    legs: card.legs,
    imageUrls: [...new Set(images)],
    imageProxyUrls: [...new Set(proxies)],
    rawText,
  };
}

export function ignoredField(name?: string | null): boolean {
  return CRYPTO_FIELD.test(name ?? "");
}
