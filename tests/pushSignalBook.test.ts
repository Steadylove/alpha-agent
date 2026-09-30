import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { continuousCache } from "./liveBooksFixtures";
import { buildSignalBooks, pushSignalBooks } from "@/lib/fund/pushSignalBook";

const mocks = vi.hoisted(() => ({ peek: vi.fn(), refresh: vi.fn(), render: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/fund/liveBooks", () => ({ peekLiveBooks: mocks.peek, refreshLiveBooks: mocks.refresh }));
vi.mock("@/lib/backtest/marketRemote", () => ({ loadMarketPanel: async () => null }));
vi.mock("@/lib/discord/bookCardImage", () => ({ renderCashBookPng: mocks.render }));
vi.mock("@/lib/notifications/postSignalImage", () => ({ postSignalImage: mocks.post }));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe("每日卡片曲线", () => {
  it.each([true, false])("fromCache=%s 两周期推送分别使用自身记账日期", async (fromCache) => {
    const cache = continuousCache({ epochs: {
      "4h": { from: "2026-01-01", resetAt: "" },
      "2h": { from: "2026-08-01", resetAt: "2026-09-09T12:00:00Z" },
    } });
    cache.books[1].view.since = "2026-08-01";
    mocks.peek.mockResolvedValue({ ...cache, stale: false });
    mocks.refresh.mockResolvedValue(cache);
    const cards = await buildSignalBooks({ fromCache });
    expect(cards.map((c) => c.input.since)).toEqual(["2026-01-01", "2026-08-01"]);
    expect(cards.map((c) => c.content)).toEqual([
      "📒 **TREND-ADAPTIVE | 趋势自适应系统 · 现金账本1**",
      "📒 **TREND-ADAPTIVE | 趋势自适应系统 · 现金账本2**",
    ]);
    expect(cards[1].summary).toContain("记账自 2026-08-01");
  });

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
      expect(card.input.cagr).toBe(20);
      expect(card.input.rows).toEqual(cache.books[0].view.rows);
    }
    expect(mocks.refresh).toHaveBeenCalledTimes(fromCache ? 0 : 1);
  });
});

describe("两周期独立投递", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.refresh.mockResolvedValue(continuousCache());
    mocks.render.mockResolvedValue(Buffer.from("image"));
    mocks.post.mockResolvedValue({ skipped: false });
  });

  it.each(["render", "post"] as const)("第一张 %s 失败仍尝试第二张，最终报告失败且不重试", async (step) => {
    mocks[step].mockRejectedValueOnce(new Error("first failed"));
    const result = pushSignalBooks().catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(Error);
    expect((await result as Error).message).toContain("first failed");
    expect(mocks.render).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenCalledTimes(step === "render" ? 1 : 2);
    expect(mocks.post.mock.lastCall?.[1].content).toContain("现金账本2");
  });

  it("两张失败都报告", async () => {
    mocks.post.mockRejectedValueOnce(new Error("first failed")).mockRejectedValueOnce(new Error("second failed"));
    const result = pushSignalBooks().catch((error: Error) => error);
    await vi.runAllTimersAsync();
    expect((await result as Error).message).toContain("first failed");
    expect((await result as Error).message).toContain("second failed");
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });

  it("跳过的通知不计入已发送", async () => {
    mocks.post.mockResolvedValue({ skipped: true });
    const result = pushSignalBooks();
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ sent: [] });
  });
});
