import { readBookEpoch } from "@/lib/fund/bookEpoch";
import { runLookback } from "@/lib/fund/lookback";
import { DEFAULT_LOOKBACK_SLOTS } from "@/lib/fund/lookbackLogic";
import { sparklineValues } from "@/lib/discord/bookCopy";
import { computeLiveBooksUrl, postComputeLiveBooks } from "@/lib/fund/deskRemote";
import {
  isLiveBookFresh,
  LIVE_BOOKS,
  liveBookCacheOf,
  livePoolKey,
  slimLookbackView,
  type LiveBookCache,
  type LiveBookOk,
} from "@/lib/fund/liveBooksLogic";
import { readLiveBooks, writeLiveBooks } from "@/lib/fund/liveBooksStore";
import { readSignalPoolMembers } from "@/lib/fund/signalPool";

export type LiveBooksResult = LiveBookCache & {
  stale: boolean;
  fromCache: boolean;
};

async function fingerprint(): Promise<{ epochFrom: string; poolKey: string; slots: number }> {
  const epoch = await readBookEpoch();
  return {
    epochFrom: epoch.from,
    poolKey: livePoolKey(await readSignalPoolMembers()),
    slots: DEFAULT_LOOKBACK_SLOTS,
  };
}

export async function saveLiveBooks(books: LiveBookOk[]): Promise<LiveBookCache> {
  const now = await fingerprint();
  const next: LiveBookCache = {
    computedAt: new Date().toISOString(),
    epochFrom: now.epochFrom,
    poolKey: now.poolKey,
    slots: now.slots,
    books: books.map((book) => ({
      tf: book.tf,
      name: book.name,
      view: slimLookbackView(book.view),
      sparkline: book.sparkline ?? sparklineValues(book.view.curve.map((p) => p.equity)),
    })),
  };
  await writeLiveBooks(next);
  return next;
}

export async function peekLiveBooks(): Promise<LiveBooksResult | null> {
  const cached = await readLiveBooks();
  if (!cached) return null;
  const now = await fingerprint();
  return {
    ...cached,
    fromCache: true,
    stale: !isLiveBookFresh(cached, now.epochFrom, now.poolKey, now.slots),
  };
}

let running: Promise<LiveBooksResult> | null = null;

export async function refreshLiveBooks(): Promise<LiveBooksResult> {
  if (computeLiveBooksUrl()) {
    const raw = await postComputeLiveBooks();
    const parsed = liveBookCacheOf(raw);
    if (!parsed) throw new Error("VPS 返回的账本缓存无效");
    return { ...parsed, stale: false, fromCache: false };
  }
  if (running) return running;
  running = (async () => {
    const now = await fingerprint();
    const books: LiveBookOk[] = [];
    for (const book of LIVE_BOOKS) {
      console.info(`[live-books] 开始 ${book.name}`);
      const view = await runLookback(book.tf, now.epochFrom, undefined, now.slots);
      books.push({ tf: book.tf, name: book.name, view });
      console.info(`[live-books] 完成 ${book.name} ${view.pnl} ${view.rows.length}只`);
    }
    const next = await saveLiveBooks(books);
    return { ...next, stale: false, fromCache: false };
  })().finally(() => {
    running = null;
  });
  return running;
}
