import { loadMarketPanel } from "@/lib/backtest/marketRemote";
import { benchmarkReturnPct } from "@/lib/backtest/spyCurve";
import { readBookEpoch } from "@/lib/fund/bookEpoch";
import { champOf, type Champ } from "@/lib/fund/champs";
import { runLookback } from "@/lib/fund/lookback";
import { type LookbackTf, type LookbackView } from "@/lib/fund/lookbackLogic";
import { readLookbackSnapshots } from "@/lib/fund/lookbackSnapshots";
import { peekLiveBooks, saveLiveBooks } from "@/lib/fund/liveBooks";
import type { LiveBookOk } from "@/lib/fund/liveBooksLogic";
import { STRATEGY_TITLE } from "@/lib/discord/brand";
import { sparklineValues, type CashBookView } from "@/lib/discord/bookCopy";

const BOOKS = ["4h", "2h-broad"] as const;

export type PushSignalBookOpts = {
  test?: boolean;
  lookback?: boolean;
  /** 有日推缓存就出图，不再拉全池重算。 */
  fromCache?: boolean;
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
  return test ? `📒 **${STRATEGY_TITLE} · ${name} 现金账本**（测试）` : `📒 **${STRATEGY_TITLE} · ${name} 现金账本**`;
}

function liveCard(
  champ: Champ,
  view: LookbackView,
  vsQqqPct: number | null,
  test: boolean,
  sparkline?: number[],
): BuiltBook {
  const s = view.stats;
  return {
    filename: `book-${champ.id}.png`,
    content: bookCaption(champ.name, test),
    summary: `${champ.name} 记账自 ${view.since.slice(0, 10)} 截至 ${view.asOf} ${view.rows.length}只`,
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
      curve: sparkline ?? sparklineValues(view.curve.map((p) => p.equity)),
      vsQqqPct,
    },
  };
}

async function builtFromCache(row: LiveBookOk, test: boolean): Promise<BuiltBook> {
  const champ = champOf(row.tf === "2h" ? "2h-broad" : row.tf);
  return liveCard(
    champ,
    row.view,
    await vsQqqOf(row.view.equity, row.view.since, row.view.asOf),
    test,
    row.sparkline,
  );
}

async function vsQqqOf(equity: number, since: string, asOf: string): Promise<number | null> {
  const panel = await loadMarketPanel("1d", "QQQ");
  if (!panel) return null;
  const closes = new Map<string, number>();
  for (let i = 0; i < panel.dates.length; i += 1) {
    const px = panel.close[i];
    if (px > 0) closes.set(panel.dates[i], px);
  }
  const qqq = benchmarkReturnPct(closes, since, asOf);
  if (qqq == null) return null;
  return (equity - 1) * 100 - qqq;
}

async function buildLive(champ: Champ, test: boolean): Promise<{ book: BuiltBook; view: LookbackView }> {
  const tf: LookbackTf = champ.config.timeframe === "2h" ? "2h" : "4h";
  const since = (await readBookEpoch()).from;
  const view = await runLookback(tf, since);
  if (view.curve.length === 0) throw new Error(`${champ.id} 现金账本是空的`);
  return {
    view,
    book: liveCard(champ, view, await vsQqqOf(view.equity, view.since, view.asOf), test),
  };
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
      curve: sparklineValues(view.curve.map((p) => p.equity)),
      vsQqqPct: await vsQqqOf(view.equity, view.since, view.asOf),
    },
  };
}

export async function buildSignalBooks(opts: PushSignalBookOpts = {}): Promise<BuiltBook[]> {
  const test = Boolean(opts.test);
  if (opts.lookback) {
    return [await buildLookback("4h", test), await buildLookback("2h", test)];
  }
  if (opts.fromCache) {
    const cached = await peekLiveBooks();
    if (cached && !cached.stale && cached.books.length >= 2) {
      console.info(`[live-books] 日推用缓存 ${cached.computedAt}`);
      return Promise.all(cached.books.map((row) => builtFromCache(row, test)));
    }
    console.info("[live-books] 没有可用缓存，现场重算");
  }
  const out: BuiltBook[] = [];
  const live: { tf: LookbackTf; name: string; view: LookbackView }[] = [];
  for (const id of BOOKS) {
    const champ = champOf(id);
    const built = await buildLive(champ, test);
    out.push(built.book);
    live.push({
      tf: champ.config.timeframe === "2h" ? "2h" : "4h",
      name: champ.name,
      view: built.view,
    });
  }
  await saveLiveBooks(live);
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
