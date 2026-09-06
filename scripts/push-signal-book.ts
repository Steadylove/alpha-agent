import "dotenv/config";

import { getPreparedUniverse } from "@/lib/backtest/load";
import { readBookEpoch } from "@/lib/fund/bookEpoch";
import { clipUniverseToSignalPool } from "@/lib/fund/signalPool";
import { champOf, type Champ } from "@/lib/fund/champs";
import { runRotate } from "@/lib/fund/rotate";
import { renderCashBookPng } from "@/lib/discord/bookCardImage";
import { postDiscordImage } from "@/lib/discord/sendWebhook";

const BOOKS = ["4h", "2h"] as const;

async function pushOne(champ: Champ, webhook: string) {
  const uni = clipUniverseToSignalPool(
    await getPreparedUniverse("SMALLFUND", champ.config.timeframe, champ.poolId),
  );
  const to = uni.axis.at(-1) ?? champ.config.to;
  const since = readBookEpoch().from;
  const raw = runRotate(uni, { ...champ.config, from: since, to }, champ.opts);
  const last = raw.holdings.at(-1);
  const lastBook = raw.book.at(-1);
  if (!last || !lastBook) throw new Error(`${champ.id} 现金账本是空的`);
  const png = await renderCashBookPng({
    asOf: last.date,
    since,
    label: champ.name,
    rows: last.rows.map((h) => ({
      symbol: h.symbol,
      floatPnlPct: h.floatPnlPct,
      entryPrice: h.entryPrice,
      weightPct: h.weightPct,
      rps: h.rps ?? h.entryRps,
    })),
    equity: lastBook.strategy,
    exposurePct: lastBook.exposurePct,
  });
  await postDiscordImage(webhook, {
    filename: `book-${champ.id}.png`,
    bytes: png,
    content: `📒 **${champ.name} 现金账本**`,
  });
  console.log(`${champ.name}  记账自 ${since.slice(0, 10)}  截至 ${last.date}  ${last.rows.length} 只`);
}

async function main() {
  const webhook = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error("未配置 DISCORD_SIGNAL_WEBHOOK_URL / DISCORD_WEBHOOK_URL");

  for (const id of BOOKS) {
    await pushOne(champOf(id), webhook);
    await new Promise((r) => setTimeout(r, 800));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
