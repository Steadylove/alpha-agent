import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

import type { GexSnapshot } from "@/lib/discord/gexCopy";
import { postSignalImage } from "@/lib/notifications/postSignalImage";
import { renderDailyDigestPng } from "@/lib/optionFlow/cardImage";
import {
  buildDailyFlowDigest,
  etCalendarDay,
  flowDigestCaption,
  hasDigestContent,
} from "@/lib/optionFlow/digest";
import { optionFlowOf, readOptionFlow } from "@/lib/optionFlow/store";

loadEnv({ override: true });

function webhookUrl(): string | undefined {
  return process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
}

async function loadFlowPosts() {
  const vps = "/var/lib/alpha-agent/desk/option-flow.json";
  if (!process.env.OPTION_FLOW_PATH && existsSync(vps)) {
    return optionFlowOf(JSON.parse(readFileSync(vps, "utf8"))).posts;
  }
  const base = process.env.MARKET_DATA_BASE_URL?.replace(/\/$/, "");
  if (base) {
    const res = await fetch(`${base}/desk/option-flow.json`);
    if (res.ok) return optionFlowOf(await res.json()).posts;
  }
  return (await readOptionFlow()).posts;
}

function loadSnapshot(): GexSnapshot | undefined {
  const file = resolve(process.argv.find((arg) => arg.endsWith(".json") && !arg.includes("option-flow")) ?? ".cache/gex/latest.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as GexSnapshot;
}

function requestedDays(posts: { kind: string; postedAt: string }[]): string[] {
  const args = process.argv.slice(2).filter((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg));
  if (args.length) return args;
  const days = new Set<string>();
  for (const post of posts) {
    if (post.kind === "flow" || post.kind === "noteworthy") days.add(etCalendarDay(post.postedAt));
  }
  return [...days].sort();
}

async function main() {
  const webhook = webhookUrl();
  if (!webhook) throw new Error("未配置 DISCORD_SIGNAL_WEBHOOK_URL / DISCORD_WEBHOOK_URL");
  const posts = await loadFlowPosts();
  const snapshot = loadSnapshot();
  const test = process.env.GEX_TEST === "1";
  for (const day of requestedDays(posts)) {
    const view = buildDailyFlowDigest(posts, snapshot, day);
    if (!hasDigestContent(view)) {
      console.log("skip", day);
      continue;
    }
    try {
      await postSignalImage(webhook, {
        filename: `option-flow-digest-${day}.png`,
        eventKey: JSON.stringify(["option-flow-digest.png", view.day, view.legs, view.spy, view.notes]),
        bytes: await renderDailyDigestPng(view),
        content: `${flowDigestCaption(test)} · ${view.title.replace("期权流 · ", "")}`,
      });
      console.log(
        "pushed",
        day,
        view.bias,
        `call=${view.callUsd}`,
        `put=${view.putUsd}`,
        `legs=${view.legs.length}`,
        `notes=${view.notes.length}`,
        view.spy ? "spy" : "no-spy",
      );
    } catch (error) {
      console.warn("fail", day, error instanceof Error ? error.message : error);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
