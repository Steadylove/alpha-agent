import { randomUUID } from "node:crypto";
import { invalidateSmallFundCache } from "@/lib/backtest/load";
import { clearRpsScaleCache } from "@/lib/backtest/rpsScale";
import { readBookEpoch } from "./bookEpoch";
import { runLookback } from "./lookback";
import { DEFAULT_LOOKBACK_SLOTS } from "./lookbackLogic";
import { sparklineValues } from "@/lib/discord/bookCopy";
import { computeLiveBooksUrl, postComputeLiveBooks } from "./deskRemote";
import { isLiveBookFresh, LIVE_BOOKS, liveBookCacheOf, livePoolKey, slimLookbackView, type LiveBookCache, type LiveBookOk } from "./liveBooksLogic";
import { liveMarketRevision, liveStrategyKey } from "./liveBooksRevision";
import { readLiveBooks, writeLiveBooks } from "./liveBooksStore";
import { readSignalPoolMembers } from "./signalPool";

export type LiveBooksResult = LiveBookCache & {
  stale: boolean;
  staleReason?: string;
  fromCache: boolean;
};

async function fingerprint() {
  const [epoch, members, market] = await Promise.all([readBookEpoch(), readSignalPoolMembers(), liveMarketRevision()]);
  return {
    epochFrom: epoch.from, poolKey: livePoolKey(members), slots: DEFAULT_LOOKBACK_SLOTS,
    ...market, strategyKey: liveStrategyKey(),
  };
}

type Fingerprint = Awaited<ReturnType<typeof fingerprint>>;

function isFresh(cache: LiveBookCache, now: Fingerprint): boolean {
  return isLiveBookFresh(cache, now.epochFrom, now.poolKey, now.slots, now);
}

export async function peekLiveBooks(): Promise<LiveBooksResult | null> {
  const cached = await readLiveBooks();
  if (!cached) return null;
  try {
    const now = await fingerprint();
    const stale = !isFresh(cached, now);
    return { ...cached, fromCache: true, stale, staleReason: stale ? "名单、起点、策略或行情已更新；当前展示上次保存的结果，请重算。" : undefined };
  } catch (error) {
    return { ...cached, fromCache: true, stale: true, staleReason: error instanceof Error ? error.message : "无法确认行情版本" };
  }
}

let running: Promise<LiveBooksResult> | null = null;

async function compute(): Promise<LiveBooksResult> {
  if (computeLiveBooksUrl()) {
    const parsed = liveBookCacheOf(await postComputeLiveBooks());
    if (!parsed) throw new Error("VPS 返回的账本缓存无效");
    const persisted = await readLiveBooks();
    if (!parsed.runId || persisted?.runId !== parsed.runId) throw new Error("计算结果尚未确认写入 VPS，请重新读取账本");
    const now = await fingerprint();
    if (!isFresh(persisted, now)) throw new Error("账本与当前配置或行情版本不一致，请重新计算");
    return { ...persisted, stale: false, fromCache: false };
  }

  const input = await fingerprint();
  const members = input.poolKey.split(",").filter(Boolean);
  if (members.length === 0) throw new Error("记账池为空，请先纳入股票");
  // 常驻 worker 每次重算都要重新读 CSV 和 RPS，不能复用昨天准备的行情。
  invalidateSmallFundCache();
  clearRpsScaleCache();
  const books: LiveBookOk[] = [];
  for (const book of LIVE_BOOKS) {
    console.info(`[live-books] 开始 ${book.name}`);
    const view = await runLookback(book.tf, input.epochFrom, members, input.slots);
    books.push({ ...book, view: slimLookbackView(view), sparkline: sparklineValues(view.curve.map((p) => p.equity)) });
  }
  if (JSON.stringify(input) !== JSON.stringify(await fingerprint())) {
    throw new Error("计算期间名单、起点或行情发生变化，未覆盖上次结果，请重算");
  }
  const next: LiveBookCache = { ...input, runId: randomUUID(), computedAt: new Date().toISOString(), books };
  if (!isFresh(next, input)) throw new Error("池内行情未覆盖当前行情清单的最新时间，未覆盖上次结果");
  await writeLiveBooks(next);
  return { ...next, stale: false, fromCache: false };
}

export function refreshLiveBooks(): Promise<LiveBooksResult> {
  if (!running) running = compute().finally(() => { running = null; });
  return running;
}
