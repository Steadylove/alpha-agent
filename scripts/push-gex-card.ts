import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

import { renderGexBriefOgPng } from "../src/lib/discord/gexBriefCardOg";
import type { GexSnapshot } from "../src/lib/discord/gexCopy";
import { gexBriefPushBody } from "../src/lib/discord/marketStateCopy";
import { postDiscordImage } from "../src/lib/discord/sendWebhook";

const envFile = loadEnv({ override: true });

function webhookUrl(): string | undefined {
  return (
    envFile.parsed?.DISCORD_SIGNAL_WEBHOOK_URL ||
    envFile.parsed?.DISCORD_WEBHOOK_URL ||
    process.env.DISCORD_SIGNAL_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL
  );
}

const DEFAULT_BOOK_PUSH = "https://alpha-agent-eight.vercel.app/api/jobs/push-signal-book";

function origin(): string {
  return new URL(process.env.BOOK_PUSH_URL || DEFAULT_BOOK_PUSH).origin;
}

async function postRemote(path: string, body: unknown): Promise<void> {
  const dest = process.env.GEX_PUSH_URL && path === "/api/tv/render-gex"
    ? process.env.GEX_PUSH_URL
    : new URL(path, `${origin()}/`).href;
  const res = await fetch(dest, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error((await res.text()).trim() || `${path} 出图失败 HTTP ${res.status}`);
  }
  console.log("pushed", dest);
}

async function postLocal(snapshot: GexSnapshot, test: boolean): Promise<void> {
  const webhook = webhookUrl();
  if (!webhook) throw new Error("未配置 DISCORD_SIGNAL_WEBHOOK_URL / DISCORD_WEBHOOK_URL");
  const body = gexBriefPushBody(snapshot, test);
  await postDiscordImage(webhook, {
    filename: body.filename,
    bytes: await renderGexBriefOgPng(body.input),
    content: body.content,
  });
  console.log("pushed local gex.png", body.input.gex.asOf);
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--local");
  const local = process.argv.includes("--local") || process.env.GEX_LOCAL === "1";
  const file = resolve(args[0] ?? ".cache/gex/latest.json");
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as GexSnapshot;
  if (!snapshot.items?.length) throw new Error(`${file} 没有 items`);
  const test = process.env.GEX_TEST === "1";
  if (local) {
    await postLocal(snapshot, test);
    return;
  }
  await postRemote("/api/tv/render-gex", gexBriefPushBody(snapshot, test));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
