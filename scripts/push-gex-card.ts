import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";

import { renderGexBriefOgPng } from "../src/lib/discord/gexBriefCardOg";
import type { GexSnapshot } from "../src/lib/discord/gexCopy";
import { gexBriefPushBody } from "../src/lib/discord/marketStateCopy";
import { postSignalImage } from "../src/lib/notifications/postSignalImage";
import { renderDailyDigestPng } from "../src/lib/optionFlow/cardImage";
import { buildDailyFlowDigest, flowDigestCaption, hasDigestContent } from "../src/lib/optionFlow/digest";
import { optionFlowOf, readOptionFlow } from "../src/lib/optionFlow/store";

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

async function postLocal(snapshot: GexSnapshot, test: boolean): Promise<void> {
  const webhook = webhookUrl() || "";
  const body = gexBriefPushBody(snapshot, test);
  const image = {
    kind: "gex" as const,
    filename: body.filename,
    eventKey: JSON.stringify([body.filename, body.content, body.input]),
    bytes: await renderGexBriefOgPng(body.input),
    content: body.content,
  };
  await postSignalImage(webhook, image);
  console.log("pushed local gex.png", body.input.gex.asOf);
}

async function postLocalDigest(snapshot: GexSnapshot, test: boolean): Promise<void> {
  const webhook = webhookUrl() || "";
  const view = buildDailyFlowDigest(await loadFlowPosts(), snapshot);
  if (!hasDigestContent(view)) {
    console.log("skip option-flow digest: 当日无订单流也无 SPY 墙");
    return;
  }
  await postSignalImage(webhook, {
    kind: "option-flow-digest",
    filename: "option-flow-digest.png",
    eventKey: JSON.stringify(["option-flow-digest.png", view.day, view.legs, view.spy, view.notes]),
    bytes: await renderDailyDigestPng(view),
    content: flowDigestCaption(test),
  });
  console.log("pushed local option-flow-digest.png", view.day);
}

async function pushFlowDigest(snapshot: GexSnapshot, local: boolean, test: boolean): Promise<void> {
  if (local) {
    await postLocalDigest(snapshot, test);
    return;
  }
  await postRemote("/api/tv/render-option-flow-digest", { snapshot, test });
}

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--local");
  const local = process.argv.includes("--local") || process.env.GEX_LOCAL === "1";
  const file = resolve(args[0] ?? ".cache/gex/latest.json");
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as GexSnapshot;
  if (!snapshot.items?.length) throw new Error(`${file} 没有 items`);
  const test = process.env.GEX_TEST === "1";
  if (local) await postLocal(snapshot, test);
  else await postRemote("/api/tv/render-gex", gexBriefPushBody(snapshot, test));
  try {
    await pushFlowDigest(snapshot, local, test);
  } catch (error) {
    console.warn("option-flow digest skip", error instanceof Error ? error.message : error);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
