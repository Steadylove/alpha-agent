import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { optionFlowConfig } from "@/lib/optionFlow/config";
import { fetchAllMessages, fetchMessagesAfter } from "@/lib/optionFlow/discordFetch";
import { enrichFromChart } from "@/lib/optionFlow/enrichChart";
import { parseRelayMessage } from "@/lib/optionFlow/parseDiscord";
import { publishOptionFlow, shouldPublish, signalChannelId, signalWebhookUrl } from "@/lib/optionFlow/publish";
import { mergeOptionFlow, readOptionFlow, writeOptionFlow } from "@/lib/optionFlow/store";
import type { OptionFlowPost } from "@/lib/optionFlow/types";

const INTERVAL_MS = Number(process.env.OPTION_FLOW_POLL_MS || 3000);
let lastOk = 0;
let lastError = "";
let running = true;

function log(message: string): void {
  console.info(`[option-flow] ${message}`);
}

async function ingestNew(): Promise<{ pulled: number; published: number }> {
  const cfg = optionFlowConfig();
  const previous = await readOptionFlow();
  if (!previous.lastMessageId) {
    const raw = await fetchAllMessages(cfg.channelId);
    const incoming: OptionFlowPost[] = [];
    for (const message of raw) {
      const parsed = parseRelayMessage(message);
      if (parsed) incoming.push(parsed);
    }
    await writeOptionFlow(mergeOptionFlow(previous, incoming, cfg.channelId));
    log(`seed ${incoming.length} posts, no publish`);
    return { pulled: raw.length, published: 0 };
  }
  const raw = await fetchMessagesAfter(cfg.channelId, previous.lastMessageId);
  const incoming: OptionFlowPost[] = [];
  let published = 0;
  for (const message of raw) {
    const parsed = parseRelayMessage(message);
    if (!parsed) continue;
    const post = await enrichFromChart(parsed);
    if (shouldPublish(post, cfg)) {
      await publishOptionFlow(post);
      post.publishedAt = new Date().toISOString();
      published += 1;
      log(`published ${post.kind} ${post.legs[0]?.ticker ?? ""} ${post.id}`);
    }
    incoming.push(post);
  }
  if (incoming.length) await writeOptionFlow(mergeOptionFlow(previous, incoming, cfg.channelId));
  return { pulled: raw.length, published };
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
  log(`listening ${process.env.PORT || 8083} webhook=${Boolean(signalWebhookUrl())} channel=${signalChannelId()}`);
});

loop().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
