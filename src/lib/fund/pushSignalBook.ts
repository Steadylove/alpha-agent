import { getPreparedUniverse } from "@/lib/backtest/load";
import { readBookEpoch } from "@/lib/fund/bookEpoch";
import { champOf, type Champ } from "@/lib/fund/champs";
import { runLookback } from "@/lib/fund/lookback";
import { winRatePctOf, type LookbackTf } from "@/lib/fund/lookbackLogic";
import { readLookbackSnapshots } from "@/lib/fund/lookbackSnapshots";
import { runRotate } from "@/lib/fund/rotate";
import { clipUniverseToSignalPool } from "@/lib/fund/signalPool";
import { renderCashBook, ytdOfNav, type CashBookView } from "@/lib/discord/bookCopy";
import { postDiscordImage, postDiscordPayload } from "@/lib/discord/sendWebhook";

const BOOKS = ["4h", "2h"] as const;

export type PushSignalBookOpts = {
  test?: boolean;
  lookback?: boolean;
};

export type PushSignalBookResult = {
  sent: string[];
};

function webhookUrl(): string {
  const url = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("未配置 DISCORD_SIGNAL_WEBHOOK_URL / DISCORD_WEBHOOK_URL");
  return url;
}

function caption(name: string, test: boolean): string {
  return test ? `📒 **${name} 现金账本**（测试）` : `📒 **${name} 现金账本**`;
}

async function sendBook(webhook: string, filename: string, input: CashBookView, test: boolean): Promise<void> {
  const content = caption(input.label, test);
  try {
    const { renderCashBookPng } = await import("@/lib/discord/bookCardImage");
    await postDiscordImage(webhook, {
      filename,
      bytes: await renderCashBookPng(input),
      content,
    });
  } catch {
    const payload = renderCashBook(input);
    await postDiscordPayload(webhook, { ...payload, content: `${content}\n${payload.content ?? ""}` });
  }
}

async function pushLive(champ: Champ, webhook: string, test: boolean): Promise<string> {
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
  const input: CashBookView = {
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
  };
  await sendBook(webhook, `book-${champ.id}.png`, input, test);
  return `${champ.name} 记账自 ${since.slice(0, 10)} 截至 ${last.date} ${last.rows.length}只`;
}

async function pushLookback(tf: LookbackTf, webhook: string, test: boolean): Promise<string> {
  const snaps = await readLookbackSnapshots();
  const snap =
    snaps.find((s) => s.tf === "4h" && s.members.length === 55) ??
    snaps.find((s) => s.tf === "4h") ??
    snaps[0];
  if (!snap) throw new Error("没有已存股票池快照");
  const view = await runLookback(tf, snap.from, snap.members, snap.slots);
  const champ = champOf(tf === "2h" ? "2h-broad" : tf);
  const s = view.stats;
  await sendBook(
    webhook,
    `book-${tf}.png`,
    {
      asOf: view.asOf,
      since: view.since,
      label: champ.name,
      rows: view.rows,
      equity: view.equity,
      ytdPct: s.ytdPct ?? undefined,
      ytdYear: s.ytdYear ?? undefined,
      exposurePct: view.exposurePct,
      dd: s.dd,
      mar: s.mar,
      avgHoldings: s.avgHoldings,
      avgExposure: s.avgExposure,
      winRatePct: s.winRatePct,
    },
    test,
  );
  const win = s.winRatePct == null ? "—" : `${s.winRatePct.toFixed(0)}%`;
  return `${champ.name} ${snap.name} 累计 ${view.pnl} 回撤 ${s.dd.toFixed(0)}% MAR ${s.mar.toFixed(2)} 均持 ${s.avgHoldings.toFixed(1)} 敞口 ${s.avgExposure.toFixed(0)}% 胜率 ${win}`;
}

export async function pushSignalBooks(opts: PushSignalBookOpts = {}): Promise<PushSignalBookResult> {
  const webhook = webhookUrl();
  const sent: string[] = [];
  if (opts.lookback) {
    for (const tf of ["4h", "2h"] as const) {
      sent.push(await pushLookback(tf, webhook, Boolean(opts.test)));
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return { sent };
  }
  for (const id of BOOKS) {
    sent.push(await pushLive(champOf(id), webhook, Boolean(opts.test)));
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return { sent };
}
