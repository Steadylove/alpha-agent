import { beforeEach, describe, expect, it, vi } from "vitest";
import { continuousCache as bookCache, bookView, bookCheckpoint } from "./liveBooksFixtures";
import { bookEpochStateOf } from "@/lib/fund/bookEpochLogic";

const mocks = vi.hoisted(() => ({
  epoch: vi.fn(), members: vi.fn(), market: vi.fn(), strategy: vi.fn(), run: vi.fn(),
  read: vi.fn(), write: vi.fn(), remoteUrl: vi.fn(), remoteRun: vi.fn(), clear: vi.fn(), clearRps: vi.fn(),
}));
vi.mock("@/lib/fund/bookEpoch", () => ({ readBookEpoch: mocks.epoch }));
vi.mock("@/lib/fund/signalPool", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/fund/signalPool")>(), readSignalPool: mocks.members }));
vi.mock("@/lib/fund/liveBooksRevision", () => ({ liveMarketRevision: mocks.market, liveStrategyKey: mocks.strategy }));
vi.mock("@/lib/fund/liveBookContinuation", () => ({ runContinuousBook: mocks.run }));
vi.mock("@/lib/fund/liveBooksStore", () => ({ readLiveBooks: mocks.read, writeLiveBooks: mocks.write, listLiveBookVersions: vi.fn(), readLiveBookVersion: vi.fn(), isBookVersionId: vi.fn() }));
vi.mock("@/lib/fund/deskRemote", () => ({ computeLiveBooksUrl: mocks.remoteUrl, postComputeLiveBooks: mocks.remoteRun }));
vi.mock("@/lib/backtest/load", () => ({ invalidateSmallFundCache: mocks.clear }));
vi.mock("@/lib/backtest/rpsScale", () => ({ clearRpsScaleCache: mocks.clearRps }));
import { peekLiveBooks, refreshLiveBooks } from "@/lib/fund/liveBooks";
import { POST } from "@/app/api/fund/live-books/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.epoch.mockResolvedValue({ from: "2026-01-01" });
  mocks.members.mockResolvedValue({ members: ["AAPL", "NVDA"], added: [], removed: [], updatedAt: "" });
  mocks.market.mockResolvedValue({ marketRevision: "market-1", asOf: { "4h": "2026-09-08T17:30", "2h": "2026-09-08T17:30" } });
  mocks.strategy.mockReturnValue("strategy-1");
  mocks.run.mockImplementation(async ({ from }) => ({ view: { ...bookCache().books[0].view, since: from }, checkpoint: bookCheckpoint() }));
  mocks.read.mockResolvedValue(bookCache());
  mocks.write.mockResolvedValue(undefined);
  mocks.remoteUrl.mockReturnValue(null);
});

describe("账本计算与缓存一致性", () => {
  it.each(["2h", "4h"] as const)("只重新记账 %s，另一个周期保留持仓、曲线；日常更新继续各自的起点", async (tf) => {
    const other = tf === "2h" ? "4h" : "2h";
    const old = bookCache();
    for (const book of old.books) book.view.curve.at(-1)!.rows = book.view.rows;
    const state = bookEpochStateOf({ from: old.epochFrom, resetAt: "" }, old.epochFrom);
    state.epochs[tf] = { from: "2026-08-01", resetAt: "2026-09-09T10:00:00Z" };
    mocks.epoch.mockResolvedValue(state);
    mocks.read.mockResolvedValue(old);
    mocks.run.mockImplementation(async ({ from, previous }) => previous
      ? { view: previous.view, checkpoint: previous.checkpoint }
      : { view: { ...bookView(), since: from }, checkpoint: bookCheckpoint() });
    expect((await peekLiveBooks())?.stale).toBe(true);
    const next = await refreshLiveBooks();
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ tf, from: "2026-08-01", previous: undefined }));
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ tf: other, from: old.epochFrom, previous: old.books.find((b) => b.tf === other) }));
    expect(next.books.find((b) => b.tf === other)).toEqual(old.books.find((b) => b.tf === other));
    expect(next.epochs).toEqual(state.epochs);
    mocks.read.mockResolvedValue(next);
    expect((await peekLiveBooks())?.stale).toBe(false);
    mocks.run.mockClear();
    await refreshLiveBooks();
    for (const book of next.books) expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ tf: book.tf,
      from: state.epochs[book.tf].from, previous: book }));
  });

  it("2H 起点日期不变但显式重开，也只重置 2H", async () => {
    const state = bookEpochStateOf({ from: "2026-01-01", resetAt: "" }, "2026-01-01");
    state.epochs["2h"].resetAt = "2026-09-09T10:00:00Z";
    mocks.epoch.mockResolvedValue(state);
    await refreshLiveBooks();
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ tf: "2h", previous: undefined }));
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ tf: "4h", previous: expect.any(Object) }));
  });

  it("计算期间另一周期改起点，拒绝保存过时结果", async () => {
    mocks.run.mockImplementationOnce(async () => {
      const state = bookEpochStateOf({ from: "2026-01-01", resetAt: "" }, "2026-01-01");
      state.epochs["2h"] = { from: "2026-08-01", resetAt: "2026-09-09T10:00:00Z" };
      mocks.epoch.mockResolvedValue(state);
      return { view: bookView(), checkpoint: bookCheckpoint() };
    });
    await expect(refreshLiveBooks()).rejects.toThrow("计算期间");
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("旧 2H 从起点重建，4H 状态继续；新 2H 下一次更新不再重置", async () => {
    const old = bookCache({ twoHourVersion: undefined });
    mocks.read.mockResolvedValue(old);
    const shown = await peekLiveBooks();
    expect(shown?.books.map((b) => b.tf)).toEqual(["4h"]);
    expect(shown?.staleReason).toContain("旧 2H");
    const rebuilt = await refreshLiveBooks();
    expect(mocks.run).toHaveBeenNthCalledWith(1, expect.objectContaining({ tf: "4h", previous: old.books[0] }));
    expect(mocks.run).toHaveBeenNthCalledWith(2, expect.objectContaining({ tf: "2h", previous: undefined, priorMembers: undefined }));
    mocks.read.mockResolvedValue(rebuilt);
    await refreshLiveBooks();
    expect(mocks.run).toHaveBeenNthCalledWith(4, expect.objectContaining({ tf: "2h", previous: rebuilt.books[1] }));
  });

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
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ tf: "4h", from: "2026-01-01", members: ["AAPL", "NVDA"], slots: 10, previous: expect.any(Object) }));
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ tf: "2h", from: "2026-01-01", members: ["AAPL", "NVDA"], slots: 10, previous: expect.any(Object) }));
    expect(first.runId).not.toBe(second.runId);
    expect(mocks.write).toHaveBeenCalledTimes(2);
  });

  it("计算期间配置变更不允许把旧结果标成新配置保存", async () => {
    mocks.run.mockImplementationOnce(async () => {
      mocks.members.mockResolvedValue({ members: ["AAPL"], added: [], removed: [], updatedAt: "" });
      return { view: bookView(), checkpoint: bookCheckpoint() };
    });
    await expect(refreshLiveBooks()).rejects.toThrow("计算期间");
    expect(mocks.run).toHaveBeenLastCalledWith(expect.objectContaining({ tf: "2h", from: "2026-01-01", members: ["AAPL", "NVDA"], slots: 10 }));
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

  it("同一天显式新建一期也不继承旧持仓，普通更新则继承", async () => {
    mocks.epoch.mockResolvedValue({ from: "2026-01-01", resetAt: "2026-09-09T08:00:00Z" });
    await refreshLiveBooks();
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ previous: undefined, priorMembers: undefined }));
  });

  it("缺一个周期的旧账本不能悄悄从零覆盖", async () => {
    mocks.read.mockResolvedValue(bookCache({ books: [bookCache().books[0]] }));
    await expect(refreshLiveBooks()).rejects.toThrow("缺少一个周期");
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("已废弃的旧 2H 缺失也能重建，但缺失 4H 仍禁止覆盖", async () => {
    const old = bookCache({ twoHourVersion: undefined, books: [bookCache().books[0]] });
    mocks.read.mockResolvedValue(old);
    await refreshLiveBooks();
    expect(mocks.run).toHaveBeenLastCalledWith(expect.objectContaining({ tf: "2h", previous: undefined }));
    mocks.read.mockResolvedValue({ ...old, books: [bookCache().books[1]] });
    await expect(refreshLiveBooks()).rejects.toThrow("缺少一个周期");
  });

  it("远程返回成功但没有持久化相同版本时不能显示成功", async () => {
    mocks.remoteUrl.mockReturnValue("http://worker/live-books");
    mocks.remoteRun.mockResolvedValue(bookCache({ runId: "new-run" }));
    await expect(refreshLiveBooks()).rejects.toThrow("尚未确认写入");
    mocks.read.mockResolvedValue(bookCache({ runId: "new-run" }));
    expect(await refreshLiveBooks()).toMatchObject({ runId: "new-run", stale: false });
  });
});
