import { beforeEach, describe, expect, it, vi } from "vitest";
import { bookCache, bookView } from "./liveBooksFixtures";

const mocks = vi.hoisted(() => ({
  epoch: vi.fn(), members: vi.fn(), market: vi.fn(), strategy: vi.fn(), run: vi.fn(),
  read: vi.fn(), write: vi.fn(), remoteUrl: vi.fn(), remoteRun: vi.fn(), clear: vi.fn(), clearRps: vi.fn(),
}));
vi.mock("@/lib/fund/bookEpoch", () => ({ readBookEpoch: mocks.epoch }));
vi.mock("@/lib/fund/signalPool", () => ({ readSignalPoolMembers: mocks.members }));
vi.mock("@/lib/fund/liveBooksRevision", () => ({ liveMarketRevision: mocks.market, liveStrategyKey: mocks.strategy }));
vi.mock("@/lib/fund/lookback", () => ({ runLookback: mocks.run }));
vi.mock("@/lib/fund/liveBooksStore", () => ({ readLiveBooks: mocks.read, writeLiveBooks: mocks.write, listLiveBookVersions: vi.fn(), readLiveBookVersion: vi.fn(), isBookVersionId: vi.fn() }));
vi.mock("@/lib/fund/deskRemote", () => ({ computeLiveBooksUrl: mocks.remoteUrl, postComputeLiveBooks: mocks.remoteRun }));
vi.mock("@/lib/backtest/load", () => ({ invalidateSmallFundCache: mocks.clear }));
vi.mock("@/lib/backtest/rpsScale", () => ({ clearRpsScaleCache: mocks.clearRps }));
import { peekLiveBooks, refreshLiveBooks } from "@/lib/fund/liveBooks";
import { POST } from "@/app/api/fund/live-books/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.epoch.mockResolvedValue({ from: "2026-01-01" });
  mocks.members.mockResolvedValue(["AAPL", "NVDA"]);
  mocks.market.mockResolvedValue({ marketRevision: "market-1", asOf: { "4h": "2026-09-08T17:30", "2h": "2026-09-08T17:30" } });
  mocks.strategy.mockReturnValue("strategy-1");
  mocks.run.mockResolvedValue(bookView());
  mocks.read.mockResolvedValue(bookCache());
  mocks.write.mockResolvedValue(undefined);
  mocks.remoteUrl.mockReturnValue(null);
});

describe("账本计算与缓存一致性", () => {
  it("行情、策略、起点、仓位或名单变化后标为过期，旧结构也只能只读展示", async () => {
    expect((await peekLiveBooks())?.stale).toBe(false);
    for (const over of [{ marketRevision: "old" }, { strategyKey: "old" }, { epochFrom: "2025-01-01" }, { slots: 8 }, { poolKey: "AAPL" }, { runId: undefined }]) {
      mocks.read.mockResolvedValue(bookCache(over));
      expect((await peekLiveBooks())?.stale).toBe(true);
    }
  });

  it("行情版本读取失败保留旧结果并明确不能确认最新", async () => {
    mocks.market.mockRejectedValue(new Error("行情正在同步"));
    expect(await peekLiveBooks()).toMatchObject({ stale: true, staleReason: "行情正在同步", runId: "test-run-1" });
  });

  it("即使版本相同，账本落后于行情清单也必须过期", async () => {
    mocks.read.mockResolvedValue(bookCache({ books: bookCache().books.map((b) => ({ ...b, view: bookView({ asOf: "2026-09-07T17:30" }) })) }));
    expect((await peekLiveBooks())?.stale).toBe(true);
  });

  it("每次重算清理行情和 RPS 缓存，两周期使用同一份输入", async () => {
    const first = await refreshLiveBooks();
    const second = await refreshLiveBooks();
    expect(mocks.clear).toHaveBeenCalledTimes(2);
    expect(mocks.clearRps).toHaveBeenCalledTimes(2);
    expect(mocks.run).toHaveBeenCalledWith("4h", "2026-01-01", ["AAPL", "NVDA"], 10);
    expect(mocks.run).toHaveBeenCalledWith("2h", "2026-01-01", ["AAPL", "NVDA"], 10);
    expect(first.runId).not.toBe(second.runId);
    expect(mocks.write).toHaveBeenCalledTimes(2);
  });

  it("计算期间配置变更不允许把旧结果标成新配置保存", async () => {
    mocks.run.mockImplementationOnce(async () => {
      mocks.members.mockResolvedValue(["AAPL"]);
      return bookView();
    });
    await expect(refreshLiveBooks()).rejects.toThrow("计算期间");
    expect(mocks.run).toHaveBeenLastCalledWith("2h", "2026-01-01", ["AAPL", "NVDA"], 10);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("同步发生在计算过程中时拒绝保存", async () => {
    mocks.market.mockResolvedValueOnce({ marketRevision: "market-1", asOf: {} }).mockResolvedValue({ marketRevision: "market-2", asOf: {} });
    await expect(refreshLiveBooks()).rejects.toThrow("计算期间");
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("保存失败时 API 返回 500，失败不会锁死下一次重试", async () => {
    mocks.write.mockRejectedValueOnce(new Error("磁盘已满"));
    const failed = await POST();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "磁盘已满" });
    expect((await POST()).status).toBe(200);
  });

  it("重复点击共享正在计算的任务", async () => {
    const one = refreshLiveBooks();
    const two = refreshLiveBooks();
    expect(one).toBe(two);
    await Promise.all([one, two]);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("远程返回成功但没有持久化相同版本时不能显示成功", async () => {
    mocks.remoteUrl.mockReturnValue("http://worker/live-books");
    mocks.remoteRun.mockResolvedValue(bookCache({ runId: "new-run" }));
    await expect(refreshLiveBooks()).rejects.toThrow("尚未确认写入");
    mocks.read.mockResolvedValue(bookCache({ runId: "new-run" }));
    expect(await refreshLiveBooks()).toMatchObject({ runId: "new-run", stale: false });
  });
});
