/**
 * Small Fund 的池子版本。买点冻结，换的是这份名单。
 *
 * - `sf-v1` / `sf-2026-08`：静态快照，回测全程都用当时那份名单。
 * - `sf-live`：活账本。原池一直在，2026-08 新加的从生效日起算。
 *
 * 引擎已有时点成分（`isMember` / `inSpan`），这里只负责生成区间。
 */

import type { MembershipSpan } from "./engine";
import { applyLiveBookChanges, extraLiveTickers, type LiveBookChange } from "./liveBookLogic";
import { SMALL_FUND_MEMBERSHIP_START, SMALL_FUND_UNIVERSE } from "./smallFundUniverse";

/** 扩池前的原名单，含抓不到价的 SKHY / SPCX。 */
export const SMALL_FUND_V1_COUNT = 97;
export const SMALL_FUND_V1_TICKERS = SMALL_FUND_UNIVERSE.slice(0, SMALL_FUND_V1_COUNT);
export const SMALL_FUND_ADDED_2026_08 = SMALL_FUND_UNIVERSE.slice(SMALL_FUND_V1_COUNT);

/** 2026-08 扩入 100 只的生效日。此前活账本里它们不进截面。 */
export const SMALL_FUND_ADDED_ON = "2026-08-01";

export const SMALL_FUND_POOL_IDS = ["sf-v1", "sf-2026-08", "sf-live"] as const;
export type SmallFundPoolId = (typeof SMALL_FUND_POOL_IDS)[number];

export const DEFAULT_SMALL_FUND_POOL: SmallFundPoolId = "sf-2026-08";

export const SMALL_FUND_POOLS: Record<
  SmallFundPoolId,
  { id: SmallFundPoolId; label: string; note: string }
> = {
  "sf-v1": {
    id: "sf-v1",
    label: "V1 原池",
    note: "扩池前约 97 只，全程静态。",
  },
  "sf-2026-08": {
    id: "sf-2026-08",
    label: "2026-08 扩池",
    note: "当前池。名单 197，有价 195（SKHY/SPCX 无日线），全程都在。",
  },
  "sf-live": {
    id: "sf-live",
    label: "活账本",
    note: "原池一直在，2026-08 新加的从当天起算；之后加减写在 live-book。",
  },
};

export function isSmallFundPoolId(value: unknown): value is SmallFundPoolId {
  return SMALL_FUND_POOL_IDS.some((id) => id === value);
}

export function parseSmallFundPoolId(raw: unknown): SmallFundPoolId {
  return isSmallFundPoolId(raw) ? raw : DEFAULT_SMALL_FUND_POOL;
}

/** 这份版本需要载入哪些 ticker 的行情。活账本还要带上后来加的票。 */
export function tickersForPool(
  id: SmallFundPoolId,
  liveChanges: readonly LiveBookChange[] = [],
): readonly string[] {
  if (id === "sf-v1") return SMALL_FUND_V1_TICKERS;
  if (id === "sf-live") {
    const extra = extraLiveTickers(liveChanges);
    return extra.length === 0 ? SMALL_FUND_UNIVERSE : [...SMALL_FUND_UNIVERSE, ...extra];
  }
  return SMALL_FUND_UNIVERSE;
}

export function membershipForPool(
  id: SmallFundPoolId,
  tickers: readonly string[],
  liveChanges: readonly LiveBookChange[] = [],
): Map<string, MembershipSpan[]> {
  const v1 = new Set(SMALL_FUND_V1_TICKERS);
  const added = new Set(SMALL_FUND_ADDED_2026_08);
  const always: MembershipSpan[] = [{ start: SMALL_FUND_MEMBERSHIP_START, end: null }];
  const afterAdd: MembershipSpan[] = [{ start: SMALL_FUND_ADDED_ON, end: null }];
  const out = new Map<string, MembershipSpan[]>();

  for (const ticker of tickers) {
    if (id === "sf-v1") {
      out.set(ticker, v1.has(ticker) ? always : []);
    } else if (id === "sf-2026-08") {
      out.set(ticker, always);
    } else if (v1.has(ticker)) {
      out.set(ticker, always);
    } else if (added.has(ticker)) {
      out.set(ticker, afterAdd);
    } else {
      out.set(ticker, []);
    }
  }
  return id === "sf-live" ? applyLiveBookChanges(out, liveChanges) : out;
}

export function membersOn(
  id: SmallFundPoolId,
  date: string,
  liveChanges: readonly LiveBookChange[] = [],
): string[] {
  const day = date.slice(0, 10);
  const tickers = tickersForPool(id, liveChanges);
  const membership = membershipForPool(id, tickers, liveChanges);
  return tickers.filter((ticker) => {
    const spans = membership.get(ticker) ?? [];
    return spans.some((s) => day >= s.start && (s.end == null || day <= s.end));
  });
}
