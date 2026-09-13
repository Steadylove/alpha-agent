import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { optionFlowConfig } from "@/lib/optionFlow/config";
import { fetchAllMessages, fetchMessagesAfter, fetchMessagesSince } from "@/lib/optionFlow/discordFetch";
import { enrichFromChart } from "@/lib/optionFlow/enrichChart";
import { parseRelayMessage } from "@/lib/optionFlow/parseDiscord";
import { publishOptionFlow, shouldPublish, signalChannelId, signalWebhookUrl } from "@/lib/optionFlow/publish";
import { mergeOptionFlow, readOptionFlow, withChannelCursor, writeOptionFlow } from "@/lib/optionFlow/store";
import type { OptionFlowPost, OptionFlowStore } from "@/lib/optionFlow/types";

const INTERVAL_MS = Number(process.env.OPTION_FLOW_POLL_MS || 3000);
/** #常规 里 X-Relay 从这天开始进频道，只补这之后的遗漏。 */
const SIGNAL_SINCE = "2026-09-12T00:00:00.000Z";
let lastOk = 0;
let lastError = "";
let running = true;

function log(message: string): void {
  console.info(`[option-flow] ${message}`);
}

async function ingestChannel(
  store: OptionFlowStore,
  channelId: string,
  publish: boolean,
  raw: Awaited<ReturnType<typeof fetchMessagesAfter>>,
): Promise<{ store: OptionFlowStore; pulled: number; published: number }> {
  const cfg = optionFlowConfig();
  const incoming: OptionFlowPost[] = [];
  let published = 0;
  for (const message of raw) {
    const parsed = parseRelayMessage(message);
    if (!parsed) continue;
    const post = await enrichFromChart(parsed);
    if (publish && shouldPublish(post, cfg, store.posts.concat(incoming))) {
      await publishOptionFlow(post);
      post.publishedAt = new Date().toISOString();
      published += 1;
      log(`published ${post.kind} ${post.legs[0]?.ticker ?? ""} ${post.id}`);
      await sleep(250);
    } else if (post.tweetId && store.posts.some((row) => row.tweetId === post.tweetId && row.publishedAt)) {
      post.publishedAt = store.posts.find((row) => row.tweetId === post.tweetId && row.publishedAt)?.publishedAt;
    }
    incoming.push(post);
  }
  let next = incoming.length ? mergeOptionFlow(store, incoming, channelId) : store;
  if (raw.length) next = withChannelCursor(next, channelId, raw[raw.length - 1]!.id);
  return { store: next, pulled: raw.length, published };
}

async function ingestNew(): Promise<{ pulled: number; published: number }> {
  const cfg = optionFlowConfig();
  const signalId = signalChannelId();
  let store = await readOptionFlow();
  let pulled = 0;
  let published = 0;

  if (!store.lastMessageId) {
    const raw = await fetchAllMessages(cfg.channelId);
    const seeded = await ingestChannel(store, cfg.channelId, false, raw);
    store = seeded.store;
    pulled += seeded.pulled;
    await writeOptionFlow(store);
    log(`seed ${store.posts.length} posts, no publish`);
  } else {
    const sourceCursor = store.lastByChannel?.[cfg.channelId] || store.lastMessageId;
    const raw = await fetchMessagesAfter(cfg.channelId, sourceCursor);
    const next = await ingestChannel(store, cfg.channelId, true, raw);
    store = next.store;
    pulled += next.pulled;
    published += next.published;
    if (next.pulled) await writeOptionFlow(store);
  }

  if (signalId && signalId !== cfg.channelId) {
    const cursor = store.lastByChannel?.[signalId];
    const raw = cursor
      ? await fetchMessagesAfter(signalId, cursor)
      : await fetchMessagesSince(signalId, SIGNAL_SINCE);
    const next = await ingestChannel(store, signalId, true, raw);
    store = next.store;
    pulled += next.pulled;
    published += next.published;
    if (next.pulled) await writeOptionFlow(store);
  }

  return { pulled, published };
}

async function loop(): Promise<void> {
  while (running) {
    try {
      await ingestNew();
      lastOk = Date.now();
      lastError = "";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "tick failed";
      console.error(`[option-flow] ${lastError}`);
    }
    await sleep(INTERVAL_MS);
  }
}

const server = createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    const ready = lastOk > 0 && Date.now() - lastOk < 30_000;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(`${JSON.stringify({ ok: true, ready, lastError: lastError || undefined })}\n`);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(Number(process.env.PORT || 8083), "0.0.0.0", () => {
  log(`listening ${process.env.PORT || 8083} webhook=${Boolean(signalWebhookUrl())} source=${optionFlowConfig().channelId} signal=${signalChannelId()}`);
});

loop().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
