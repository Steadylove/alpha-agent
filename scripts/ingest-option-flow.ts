import "dotenv/config";

import { optionFlowConfig, shouldForward } from "@/lib/optionFlow/config";
import { fetchAllMessages, fetchMessagesAfter } from "@/lib/optionFlow/discordFetch";
import { enrichFromChart } from "@/lib/optionFlow/enrichChart";
import { parseRelayMessage } from "@/lib/optionFlow/parseDiscord";
import { mergeOptionFlow, optionFlowPath, readOptionFlow, writeOptionFlow } from "@/lib/optionFlow/store";
import type { OptionFlowPost } from "@/lib/optionFlow/types";

async function main() {
  const cfg = optionFlowConfig();
  const previous = await readOptionFlow();
  const full = process.argv.includes("--full") || !previous.lastMessageId;
  const raw = full
    ? await fetchAllMessages(cfg.channelId)
    : await fetchMessagesAfter(cfg.channelId, previous.lastMessageId);
  const incoming: OptionFlowPost[] = [];
  for (const message of raw) {
    const parsed = parseRelayMessage(message);
    if (parsed) incoming.push(await enrichFromChart(parsed));
  }
  const store = await writeOptionFlow(mergeOptionFlow(previous, incoming, cfg.channelId));
  const kinds = new Map<string, number>();
  for (const post of store.posts) kinds.set(post.kind, (kinds.get(post.kind) ?? 0) + 1);
  const forwardable = store.posts.filter((post) => shouldForward(post, cfg)).length;
  console.log(
    JSON.stringify(
      {
        channelId: cfg.channelId,
        pulled: raw.length,
        ingested: incoming.length,
        stored: store.posts.length,
        kinds: Object.fromEntries(kinds),
        forwardable,
        minPremiumUsd: cfg.minPremiumUsd,
        file: optionFlowPath(),
        lastMessageId: store.lastMessageId,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
