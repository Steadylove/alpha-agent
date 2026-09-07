import "dotenv/config";

import { getPreparedUniverse } from "@/lib/backtest/load";
import { readBookEpoch } from "@/lib/fund/bookEpoch";
import { clipUniverseToSignalPool } from "@/lib/fund/signalPool";
import { champOf, type Champ } from "@/lib/fund/champs";
import { runLookback } from "@/lib/fund/lookback";
import { winRatePctOf, type LookbackTf } from "@/lib/fund/lookbackLogic";
import { readLookbackSnapshots } from "@/lib/fund/lookbackSnapshots";
import { runRotate } from "@/lib/fund/rotate";
import { ytdOfNav } from "@/lib/discord/bookCopy";
import { cashBookFromLookback, renderCashBookPng } from "@/lib/discord/bookCardImage";
import { postDiscordImage } from "@/lib/discord/sendWebhook";

const BOOKS = ["4h", "2h"] as const;
const TEST = process.argv.includes("--test");
const LOOKBACK = process.argv.includes("--lookback");

async function pushOne(champ: Champ, webhook: string) {
  const uni = await clipUniverseToSignalPool(
    await getPreparedUniverse("SMALLFUND", champ.config.timeframe, champ.poolId),
  );
  const to = uni.axis.at(-1) ?? champ.config.to;
  const since = (await readBookEpoch()).from;
  const raw = runRotate(uni, { ...champ.config, from: since, to }, champ.opts);
  const last = raw.holdings.at(-1);
  const lastBook = raw.book.at(-1);
  if (!last || !lastBook) throw new Error(`${champ.id} 现金账本是空的`);
  const ytd = ytdOfNav(raw.book.map((b) => ({ date: b.date, equity: b.strategy })));
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
    ytdPct: ytd?.pct,
    ytdYear: ytd?.year,
    exposurePct: lastBook.exposurePct,
    dd: raw.dd,
    mar: raw.mar,
    avgHoldings: raw.avgHoldings,
    avgExposure: raw.avgExposure,
    winRatePct: winRatePctOf(raw.lotPnl.map((x) => x.pct)),
  });
  await postDiscordImage(webhook, {
    filename: `book-${champ.id}.png`,
    bytes: png,
    content: TEST ? `📒 **${champ.name} 现金账本**（测试）` : `📒 **${champ.name} 现金账本**`,
  });
  console.log(`${champ.name}  记账自 ${since.slice(0, 10)}  截至 ${last.date}  ${last.rows.length} 只`);
}

async function pushLookback(tf: LookbackTf, webhook: string) {
  const snaps = await readLookbackSnapshots();
  const snap =
    snaps.find((s) => s.tf === "4h" && s.members.length === 55) ??
    snaps.find((s) => s.tf === "4h") ??
    snaps[0];
  if (!snap) throw new Error("没有已存股票池快照");
  const view = await runLookback(tf, snap.from, snap.members, snap.slots);
  const champ = champOf(tf === "2h" ? "2h-broad" : tf);
  const png = await renderCashBookPng(cashBookFromLookback(view, champ.name));
  await postDiscordImage(webhook, {
    filename: `book-${tf}.png`,
    bytes: png,
    content: TEST ? `📒 **${champ.name} 现金账本**（测试）` : `📒 **${champ.name} 现金账本**`,
  });
  const s = view.stats;
  console.log(
    `${champ.name}  ${snap.name}  累计 ${view.pnl}  回撤 ${s.dd.toFixed(0)}%  MAR ${s.mar.toFixed(2)}  均持 ${s.avgHoldings.toFixed(1)}  敞口 ${s.avgExposure.toFixed(0)}%  胜率 ${s.winRatePct == null ? "—" : `${s.winRatePct.toFixed(0)}%`}`,
  );
}

async function main() {
  const webhook = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error("未配置 DISCORD_SIGNAL_WEBHOOK_URL / DISCORD_WEBHOOK_URL");

  if (LOOKBACK) {
    for (const tf of ["4h", "2h"] as const) {
      await pushLookback(tf, webhook);
      await new Promise((r) => setTimeout(r, 800));
    }
    return;
  }

  for (const id of BOOKS) {
    await pushOne(champOf(id), webhook);
    await new Promise((r) => setTimeout(r, 800));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
