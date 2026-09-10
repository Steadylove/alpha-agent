import { beforeEach, describe, expect, it, vi } from "vitest";
import { continuousCache } from "./liveBooksFixtures";
import { buildSignalBooks } from "@/lib/fund/pushSignalBook";

const mocks = vi.hoisted(() => ({ peek: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/fund/liveBooks", () => ({ peekLiveBooks: mocks.peek, refreshLiveBooks: mocks.refresh }));
vi.mock("@/lib/backtest/marketRemote", () => ({ loadMarketPanel: async () => null }));
beforeEach(() => vi.resetAllMocks());

describe("每日卡片曲线", () => {
  it.each([true, false])("fromCache=%s 出图从完整已记账曲线采样，不能使用旧的两点直线", async (fromCache) => {
    const cache = continuousCache();
    for (const b of cache.books) {
      b.checkpoint!.dailyEquity.unshift({ date: "2026-01-02", v: 1.01 }, { date: "2026-09-07", v: 1.21 });
      b.sparkline = [1.21, 1.2];
    }
    mocks.peek.mockResolvedValue({ ...cache, stale: false });
    mocks.refresh.mockResolvedValue(cache);
    const cards = await buildSignalBooks({ fromCache });
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.input.curve).toEqual([1.01, 1.21, 1.2]);
      expect(card.input.equity).toBe(1.2);
      expect(card.input.rows).toEqual(cache.books[0].view.rows);
    }
    expect(mocks.refresh).toHaveBeenCalledTimes(fromCache ? 0 : 1);
  });
});
