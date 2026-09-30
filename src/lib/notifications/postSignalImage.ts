import { postDiscordImage } from "@/lib/discord/sendWebhook";
import { postDiscordMirror } from "@/lib/discord/mirrorWebhook";
import { enqueueTelegramImage } from "@/lib/telegram/relay";

import { discordWebhookOf, meetsFlowPremium, readPushRoutes, resolveDiscordTargets, type PushKind } from "./pushRoutes";

export type PushImage = {
  kind: PushKind;
  filename: string;
  bytes: Buffer;
  content?: string;
  eventKey?: string;
  premiumUsd?: number;
};

/** 按网页配置发 Discord / Telegram。镜像频道失败不挡主频道。 */
export async function postSignalImage(webhook: string, input: PushImage): Promise<{ skipped: boolean }> {
  const settings = await readPushRoutes({ strict: input.kind === "option-flow" });
  const route = settings.routes[input.kind];
  if (!route.enabled) return { skipped: true };
  if (input.kind === "option-flow" && !meetsFlowPremium(input.premiumUsd, settings.optionFlowMinPremiumUsd)) return { skipped: true };

  const image = { filename: input.filename, bytes: input.bytes, content: input.content, eventKey: input.eventKey };
  const tasks: Array<{ name: string; run: Promise<void | { skipped: boolean }> }> = [];

  if (route.discord) {
    const dests = resolveDiscordTargets(route, (dest) => discordWebhookOf(dest, webhook));
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
      run: enqueueTelegramImage(image, route.telegramAll ? undefined : route.telegramChats).then((result) => {
        if ("ok" in result && result.ok === false) throw new Error("推送服务返回失败");
        return { skipped: ("skipped" in result && result.skipped === true) || ("recipients" in result && result.recipients === 0) };
      }),
    });
  }

  if (!tasks.length) return { skipped: true };
  const results = await Promise.allSettled(tasks.map((task) => task.run));
  const errors = results.flatMap((result, i) => (
    result.status === "rejected" ? [`${tasks[i]!.name}: ${result.reason instanceof Error ? result.reason.message : "推送失败"}`] : []
  ));
  if (errors.length) throw new Error(errors.join("; "));
  return { skipped: results.every((result) => result.status === "fulfilled" && result.value?.skipped === true) };
}
