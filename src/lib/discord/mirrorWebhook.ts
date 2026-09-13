import { postDiscordImage } from "@/lib/discord/sendWebhook";

const KEYS = {
  gex: "DISCORD_MIRROR_GEX_WEBHOOK_URL",
  book: "DISCORD_MIRROR_BOOK_WEBHOOK_URL",
  "4h": "DISCORD_MIRROR_4H_WEBHOOK_URL",
  "2h": "DISCORD_MIRROR_2H_WEBHOOK_URL",
} as const;

export type DiscordMirrorKind = keyof typeof KEYS;

export function discordMirrorWebhook(kind: DiscordMirrorKind): string {
  return (process.env[KEYS[kind]] || "").trim();
}

/** 新群抄送；失败只打日志，不挡 #常规 / Telegram。 */
export async function postDiscordMirror(
  webhook: string,
  input: { filename: string; bytes: Buffer; content?: string },
): Promise<void> {
  if (!webhook) return;
  try {
    await postDiscordImage(webhook, input);
  } catch (error) {
    console.warn(`[discord-mirror] ${error instanceof Error ? error.message : "推送失败"}`);
  }
}
