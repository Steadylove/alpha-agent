import { appConfig } from "../app.config";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { filterForwardPost, optionFlowConfig } from "@/lib/optionFlow/config";
import { readPushRoutes } from "@/lib/notifications/pushRoutes";
import { fetchAllMessages, fetchMessagesAfter, fetchMessagesSince } from "@/lib/optionFlow/discordFetch";
import { enrichFromChart } from "@/lib/optionFlow/enrichChart";
import { parseRelayMessage } from "@/lib/optionFlow/parseDiscord";
import { publishOptionFlow, shouldPublish, signalChannelId, signalWebhookUrl } from "@/lib/optionFlow/publish";
import { mergeOptionFlow, readOptionFlow, withChannelCursor, writeOptionFlow } from "@/lib/optionFlow/store";
import type { OptionFlowConfig, OptionFlowPost, OptionFlowStore } from "@/lib/optionFlow/types";
import { completeFlowCollection, flowChannelHealth, readLocalFlowCollectionHealth, safeFlowCollectionError, writeFlowCollectionHealth, type FlowChannelHealth, type FlowCollectionHealth } from "@/lib/optionFlow/health";

const INTERVAL_MS = Number(process.env.OPTION_FLOW_POLL_MS || appConfig.optionFlow.pollMs);
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
  cfg: OptionFlowConfig,
  capture: "live" | "backfill" = "live",
): Promise<{ store: OptionFlowStore; pulled: number; published: number }> {
  const incoming: OptionFlowPost[] = [];
  let published = 0;
  for (const message of raw) {
    const parsed = parseRelayMessage(message, new Date(), { channelId, capture });
    if (!parsed) continue;
    const post = await enrichFromChart(parsed);
    if (publish && shouldPublish(post, cfg, store.posts.concat(incoming))) {
      const outgoing = filterForwardPost(post, cfg)!;
      const result = await publishOptionFlow(outgoing);
      if (!result.skipped) {
        post.publishedAt = new Date().toISOString();
        published += 1;
        log(`published ${post.kind} ${post.legs[0]?.ticker ?? ""} ${post.id}`);
        await sleep(250);
      }
    } else if (post.tweetId && store.posts.some((row) => row.tweetId === post.tweetId && row.publishedAt)) {
      post.publishedAt = store.posts.find((row) => row.tweetId === post.tweetId && row.publishedAt)?.publishedAt;
    }
    incoming.push(post);
  }
  let next = incoming.length ? mergeOptionFlow(store, incoming, channelId) : store;
  if (raw.length) next = withChannelCursor(next, channelId, raw[raw.length - 1]!.id);
  return { store: next, pulled: raw.length, published };
}

async function ingestNew(channels: FlowChannelHealth[], expectedChannelIds: string[]): Promise<{ pulled: number; published: number }> {
  // A failed settings read must not silently relax a saved higher threshold.
  const settings = await readPushRoutes({ strict: true });
  const cfg = { ...optionFlowConfig(), minPremiumUsd: settings.optionFlowMinPremiumUsd };
  const signalId = signalChannelId();
  expectedChannelIds.push(cfg.channelId, ...(signalId && signalId !== cfg.channelId ? [signalId] : []));
  let store = await readOptionFlow();
  let pulled = 0;
  let published = 0;

  const collect = async (channelId: string, publish: boolean, mode: FlowChannelHealth["mode"], afterId?: string, since?: string) => {
    const startedAt = new Date().toISOString();
    let raw: Awaited<ReturnType<typeof fetchMessagesAfter>> | undefined;
    try {
      raw = mode === "full" ? await fetchAllMessages(channelId) : mode === "since" ? await fetchMessagesSince(channelId, since!) : await fetchMessagesAfter(channelId, afterId!);
      const next = await ingestChannel(store, channelId, publish, raw, cfg, mode === "incremental" ? "live" : "backfill");
      store = next.store;
      if (next.pulled || mode === "full") await writeOptionFlow(store);
      channels.push(flowChannelHealth({ channelId, mode, startedAt, completedAt: new Date().toISOString(), since, afterId, raw }));
      return next;
    } catch (error) {
      channels.push(flowChannelHealth({ channelId, mode, startedAt, completedAt: new Date().toISOString(), since, afterId, raw, error, failed: true }));
      throw error;
    }
  };

  if (!store.lastMessageId) {
    const seeded = await collect(cfg.channelId, false, "full");
    pulled += seeded.pulled;
    log(`seed ${store.posts.length} posts, no publish`);
  } else {
    const sourceCursor = store.lastByChannel?.[cfg.channelId] || store.lastMessageId;
    const next = await collect(cfg.channelId, true, "incremental", sourceCursor);
    pulled += next.pulled;
    published += next.published;
  }

  if (signalId && signalId !== cfg.channelId) {
    const cursor = store.lastByChannel?.[signalId];
    const next = await collect(signalId, true, cursor ? "incremental" : "since", cursor, cursor ? undefined : SIGNAL_SINCE);
    pulled += next.pulled;
    published += next.published;
  }

  return { pulled, published };
}

async function loop(): Promise<void> {
  let previousHealth: FlowCollectionHealth | null = readLocalFlowCollectionHealth();
  while (running) {
    const startedAt = new Date().toISOString(), channels: FlowChannelHealth[] = [], expectedChannelIds: string[] = [];
    let failure: unknown, failed = false;
    try {
      await ingestNew(channels, expectedChannelIds);
      lastOk = Date.now();
      lastError = "";
    } catch (error) {
      failed = true; failure = error;
      lastError = safeFlowCollectionError(error);
      console.error(`[option-flow] ${lastError}`);
    } finally {
      const health = completeFlowCollection({ startedAt, checkedAt: new Date().toISOString(), expectedChannelIds, channels, failed, error: failure, previous: previousHealth });
      try { await writeFlowCollectionHealth(health); previousHealth = health; }
      catch { console.error("[option-flow] collection health persistence unavailable"); }
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
