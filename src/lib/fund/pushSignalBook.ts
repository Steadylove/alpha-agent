import { getPreparedUniverse } from "@/lib/backtest/load";
import { readBookEpoch } from "@/lib/fund/bookEpoch";
import { champOf, type Champ } from "@/lib/fund/champs";
import { runLookback } from "@/lib/fund/lookback";
import { winRatePctOf, type LookbackTf } from "@/lib/fund/lookbackLogic";
import { readLookbackSnapshots } from "@/lib/fund/lookbackSnapshots";
import { runRotate } from "@/lib/fund/rotate";
import { clipUniverseToSignalPool } from "@/lib/fund/signalPool";
import { ytdOfNav, type CashBookView } from "@/lib/discord/bookCopy";

const BOOKS = ["4h", "2h"] as const;

export type PushSignalBookOpts = {
  test?: boolean;
  lookback?: boolean;
};

export type BuiltBook = {
  filename: string;
  content: string;
  summary: string;
  input: CashBookView;
};

export type PushSignalBookResult = {
  sent: string[];
};

export function bookCaption(name: string, test: boolean): string {
  return test ? `📒 **${name} 现金账本**（测试）` : `📒 **${name} 现金账本**`;
}

function liveCard(champ: Champ, since: string, last: { date: string; rows: CashBookView["rows"] }, lastBook: { strategy: number; exposurePct: number }, raw: { dd: number; mar: number; avgHoldings: number; avgExposure: number; lotPnl: { pct: number }[] }, ytd: { pct: number; year: number } | null, test: boolean): BuiltBook {
  return {
    filename: `book-${champ.id}.png`,
    content: bookCaption(champ.name, test),
    summary: `${champ.name} 记账自 ${since.slice(0, 10)} 截至 ${last.date} ${last.rows.length}只`,
    input: {
      asOf: last.date,
      since,
      label: champ.name,
      rows: last.rows,
      equity: lastBook.strategy,
      ytdPct: ytd?.pct,
      ytdYear: ytd?.year,
      exposurePct: lastBook.exposurePct,
      dd: raw.dd,
      mar: raw.mar,
      avgHoldings: raw.avgHoldings,
      avgExposure: raw.avgExposure,
      winRatePct: winRatePctOf(raw.lotPnl.map((x) => x.pct)),
    },
  };
}

async function buildLive(champ: Champ, test: boolean): Promise<BuiltBook> {
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
  return liveCard(
    champ,
    since,
    {
      date: last.date,
      rows: last.rows.map((h) => ({
        symbol: h.symbol,
        floatPnlPct: h.floatPnlPct,
        entryPrice: h.entryPrice,
        weightPct: h.weightPct,
        rps: h.rps ?? h.entryRps,
      })),
    },
    lastBook,
    raw,
    ytd,
    test,
  );
}

async function buildLookback(tf: LookbackTf, test: boolean): Promise<BuiltBook> {
  const snaps = await readLookbackSnapshots();
  const snap =
    snaps.find((s) => s.tf === "4h" && s.members.length === 55) ??
    snaps.find((s) => s.tf === "4h") ??
    snaps[0];
  if (!snap) throw new Error("没有已存股票池快照");
  const view = await runLookback(tf, snap.from, snap.members, snap.slots);
  const champ = champOf(tf === "2h" ? "2h-broad" : tf);
  const s = view.stats;
  const win = s.winRatePct == null ? "—" : `${s.winRatePct.toFixed(0)}%`;
  return {
    filename: `book-${tf}.png`,
    content: bookCaption(champ.name, test),
    summary: `${champ.name} ${snap.name} 累计 ${view.pnl} 回撤 ${s.dd.toFixed(0)}% MAR ${s.mar.toFixed(2)} 均持 ${s.avgHoldings.toFixed(1)} 敞口 ${s.avgExposure.toFixed(0)}% 胜率 ${win}`,
    input: {
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
  };
}

export async function buildSignalBooks(opts: PushSignalBookOpts = {}): Promise<BuiltBook[]> {
  const test = Boolean(opts.test);
  if (opts.lookback) {
    return [await buildLookback("4h", test), await buildLookback("2h", test)];
  }
  const out: BuiltBook[] = [];
  for (const id of BOOKS) out.push(await buildLive(champOf(id), test));
  return out;
}

export async function pushSignalBooks(opts: PushSignalBookOpts = {}): Promise<PushSignalBookResult> {
  const webhook = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) throw new Error("未配置 DISCORD_SIGNAL_WEBHOOK_URL / DISCORD_WEBHOOK_URL");
  const { renderCashBookPng } = await import("@/lib/discord/bookCardImage");
  const { postDiscordImage } = await import("@/lib/discord/sendWebhook");
  const sent: string[] = [];
  for (const book of await buildSignalBooks(opts)) {
    await postDiscordImage(webhook, {
      filename: book.filename,
      bytes: await renderCashBookPng(book.input),
      content: book.content,
    });
    sent.push(book.summary);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return { sent };
}
