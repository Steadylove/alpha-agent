import type { DiscordMessageLike } from "./parseDiscord";

const API = "https://discord.com/api/v10";

export function discordBotToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) throw new Error("未配置 DISCORD_BOT_TOKEN");
  return token;
}

async function getMessages(channelId: string, token: string, query: Record<string, string>): Promise<DiscordMessageLike[]> {
  const url = new URL(`${API}/channels/${channelId}/messages`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const res = await fetch(url, {
    headers: { authorization: `Bot ${token}`, "user-agent": "alpha-agent-option-flow" },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Discord 拉消息失败 HTTP ${res.status}`);
  return JSON.parse(body) as DiscordMessageLike[];
}

/** 增量：只取 after 之后的新消息，时间从旧到新。 */
export async function fetchMessagesAfter(channelId: string, after: string, token = discordBotToken()): Promise<DiscordMessageLike[]> {
  const out: DiscordMessageLike[] = [];
  let cursor = after;
  while (true) {
    const batch = await getMessages(channelId, token, { after: cursor, limit: "100" });
    if (!batch.length) break;
    out.push(...[...batch].reverse());
    cursor = batch[0].id;
    if (batch.length < 100) break;
  }
  return out;
}

/** 全量：从新往旧翻，返回从旧到新。 */
export async function fetchAllMessages(channelId: string, token = discordBotToken()): Promise<DiscordMessageLike[]> {
  const newestFirst: DiscordMessageLike[] = [];
  let before: string | undefined;
  while (true) {
    const batch = await getMessages(channelId, token, before ? { before, limit: "100" } : { limit: "100" });
    if (!batch.length) break;
    newestFirst.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return newestFirst.reverse();
}
