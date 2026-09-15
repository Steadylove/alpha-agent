import { postDiscordImage } from "@/lib/discord/sendWebhook";
import { postDiscordMirror } from "@/lib/discord/mirrorWebhook";
import { enqueueTelegramImage } from "@/lib/telegram/relay";

import { discordWebhookOf, readPushRoutes, resolveDiscordTargets, type PushKind } from "./pushRoutes";

export type PushImage = {
  kind: PushKind;
  filename: string;
  bytes: Buffer;
  content?: string;
  eventKey?: string;
};

/** 按网页配置发 Discord / Telegram。镜像频道失败不挡主频道。 */
export async function postSignalImage(webhook: string, input: PushImage): Promise<{ skipped: boolean }> {
  const route = (await readPushRoutes()).routes[input.kind];
  if (!route.enabled) return { skipped: true };

  const image = { filename: input.filename, bytes: input.bytes, content: input.content, eventKey: input.eventKey };
  const tasks: Array<{ name: string; run: Promise<unknown> }> = [];

  if (route.discord) {
    const dests = resolveDiscordTargets(route, (dest) => discordWebhookOf(dest, webhook));
    if (!dests.length) {
      tasks.push({ name: "Discord", run: Promise.reject(new Error("Discord webhook 未配置")) });
    }
    for (const row of dests) {
      tasks.push({
        name: "Discord",
        run: row.mirror ? postDiscordMirror(row.url, image) : postDiscordImage(row.url, image),
      });
    }
  }

  if (route.telegram && (route.telegramAll || route.telegramChats.length)) {
    tasks.push({
      name: "Telegram",
      run: enqueueTelegramImage(image, route.telegramAll ? undefined : route.telegramChats),
    });
  }

  if (!tasks.length) return { skipped: true };
  const results = await Promise.allSettled(tasks.map((task) => task.run));
  const errors = results.flatMap((result, i) => (
    result.status === "rejected" ? [`${tasks[i]!.name}: ${result.reason instanceof Error ? result.reason.message : "推送失败"}`] : []
  ));
  if (errors.length) throw new Error(errors.join("; "));
  return { skipped: false };
}
