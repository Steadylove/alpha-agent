import { createHash, randomUUID } from "node:crypto";
import { invalidateSmallFundCache } from "@/lib/backtest/load";
import { clearRpsScaleCache } from "@/lib/backtest/rpsScale";
import { readBookEpoch } from "./bookEpoch";
import { runContinuousBook } from "./liveBookContinuation";
import { DEFAULT_LOOKBACK_SLOTS } from "./lookbackLogic";
import { sparklineValues } from "@/lib/discord/bookCopy";
import { computeLiveBooksUrl, postComputeLiveBooks } from "./deskRemote";
import { isLiveBookFresh, LIVE_BOOKS, liveBookCacheOf, livePoolKey, slimLookbackView, withoutObsoleteTwoHour, type LiveBookCache, type LiveBookOk } from "./liveBooksLogic";
import { liveMarketRevision, liveStrategyKey } from "./liveBooksRevision";
import { readLiveBooks, writeLiveBooks } from "./liveBooksStore";
import { applySignalPool, defaultSignalPoolTickers, readSignalPool } from "./signalPool";
import type { PoolRevision } from "./poolTimeline";
import { TWO_HOUR_VERSION } from "@/lib/backtest/twoHourVersion";

export type LiveBooksResult = LiveBookCache & {
  stale: boolean;
  staleReason?: string;
  fromCache: boolean;
};

async function fingerprint() {
  const [epoch, pool, market] = await Promise.all([readBookEpoch(), readSignalPool(), liveMarketRevision()]);
  const members = applySignalPool(defaultSignalPoolTickers(), pool);
  return {
    epochFrom: epoch.from, poolKey: livePoolKey(members), slots: DEFAULT_LOOKBACK_SLOTS,
    twoHourVersion: TWO_HOUR_VERSION,
    epochResetAt: epoch.resetAt || "", poolUpdatedAt: pool.updatedAt,
    poolHistory: pool.revisions,
    poolRevision: createHash("sha256").update(JSON.stringify({ members, updatedAt: pool.updatedAt, revisions: pool.revisions })).digest("hex"),
    ...market, strategyKey: liveStrategyKey(),
  };
}

type Fingerprint = Awaited<ReturnType<typeof fingerprint>>;

function isFresh(cache: LiveBookCache, now: Fingerprint): boolean {
  return cache.twoHourVersion === TWO_HOUR_VERSION && cache.accounting === "continuous-v1" && cache.epochResetAt === now.epochResetAt && cache.poolRevision === now.poolRevision &&
    isLiveBookFresh(cache, now.epochFrom, now.poolKey, now.slots, now);
}

export async function peekLiveBooks(): Promise<LiveBooksResult | null> {
  const cached = await readLiveBooks();
  if (!cached) return null;
  const visible = withoutObsoleteTwoHour(cached);
  try {
    const now = await fingerprint();
    const stale = !isFresh(cached, now);
    return { ...visible, fromCache: true, stale, staleReason: cached.twoHourVersion !== TWO_HOUR_VERSION
      ? "旧 2H 三根口径已作废。更新账本后按标准四根 2H 从当前起点重建，4H 继续原账本。"
      : stale ? "名单、起点、策略或行情已更新；当前展示上次保存的结果，请更新账本。" : undefined };
  } catch (error) {
    return { ...visible, fromCache: true, stale: true, staleReason: error instanceof Error ? error.message : "无法确认行情版本" };
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
  const previous = await readLiveBooks();
  const members = input.poolKey.split(",").filter(Boolean);
  const continuing = previous && previous.epochFrom === input.epochFrom &&
    (previous.epochResetAt != null ? previous.epochResetAt === input.epochResetAt : !input.epochResetAt || Date.parse(input.epochResetAt) <= Date.parse(previous.computedAt));
  if (continuing && LIVE_BOOKS.some((b) => (b.tf !== "2h" || previous.twoHourVersion === TWO_HOUR_VERSION) &&
    !previous.books.some((p) => p.tf === b.tf))) throw new Error("旧账本缺少一个周期，不能从零覆盖原成绩");
  const priorMembers = continuing ? previous.poolKey.split(",").filter(Boolean) : undefined;
  const history: PoolRevision[] = input.poolHistory ?? (continuing && previous.poolHistory ? [...previous.poolHistory]
    : [{ id: "baseline", effectiveAt: "", members: priorMembers ?? members }]);
  if (JSON.stringify(history.at(-1)?.members.slice().sort()) !== JSON.stringify(members)) {
    history.push({ id: input.poolRevision, effectiveAt: input.poolUpdatedAt || new Date().toISOString(), members });
  }
  // 常驻 worker 每次重算都要重新读 CSV 和 RPS，不能复用昨天准备的行情。
  invalidateSmallFundCache();
  clearRpsScaleCache();
  const books: LiveBookOk[] = [];
  for (const book of LIVE_BOOKS) {
    console.info(`[live-books] 开始 ${book.name}`);
    const keep = continuing && (book.tf !== "2h" || previous.twoHourVersion === TWO_HOUR_VERSION);
    const { view, checkpoint } = await runContinuousBook({ tf: book.tf, from: input.epochFrom, members, slots: input.slots, history,
      previous: keep ? previous.books.find((p) => p.tf === book.tf) : undefined, priorMembers: keep ? priorMembers : undefined });
    books.push({ ...book, checkpoint, view: slimLookbackView(view), sparkline: sparklineValues(view.curve.map((p) => p.equity)) });
  }
  if (JSON.stringify(input) !== JSON.stringify(await fingerprint())) {
    throw new Error("计算期间名单、起点或行情发生变化，未覆盖上次结果，请重算");
  }
  const next: LiveBookCache = { ...input, accounting: "continuous-v1", poolHistory: history, runId: randomUUID(), computedAt: new Date().toISOString(), books };
  if (!isFresh(next, input)) throw new Error("池内行情未覆盖当前行情清单的最新时间，未覆盖上次结果");
  await writeLiveBooks(next);
  return { ...next, stale: false, fromCache: false };
}

export function refreshLiveBooks(): Promise<LiveBooksResult> {
  if (!running) running = compute().finally(() => { running = null; });
  return running;
}
