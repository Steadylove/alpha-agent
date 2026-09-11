import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FUND_SCORE_VERSION, lookupAlertFundScore, runFundScoreJob } from "@/lib/jobs/fundScore";
import { fundScoreOf } from "@/lib/scoring/fundScore";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), bars: vi.fn(), sec: vi.fn() }));
vi.mock("@/lib/vps/snapshot", () => ({ readSnapshot: mocks.read, writeSnapshot: mocks.write }));
vi.mock("@/lib/vps/loadDailyBars", () => ({ loadDailyBars: mocks.bars }));
vi.mock("@/lib/data-sources/secFacts", () => ({ fetchSecFundInputs: mocks.sec }));
const inputs = { epsYoy: .5, revYoy: .4, roe: .3, gmTtm: .5, debtEquity: 1 };
const oldScore = fundScoreOf({ ...inputs, dist52w: -30 });
const snapshot = (extra: object = {}) => ({ version: FUND_SCORE_VERSION, asOf: "2026-09-11T00:00:00Z", rows: [{ symbol: "AAPL", name: "Apple", score: oldScore }], ...extra });

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T01:00:00Z"));
  mocks.sec.mockResolvedValue(inputs);
  mocks.bars.mockResolvedValue(new Map(["AAPL", "NVDA"].map((symbol) => [symbol, Array.from({ length: 253 }, () => ({ close: 100 }))])));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("评分更新和告警降级", () => {
  it("有效快照直接使用，不重复请求 SEC", async () => {
    mocks.read.mockResolvedValue(snapshot());
    expect(await lookupAlertFundScore("aapl")).toEqual(oldScore);
    expect(mocks.sec).not.toHaveBeenCalled();
  });

  it.each([
    { version: undefined }, { version: 1 }, { asOf: "2026-09-09T00:00:00Z" },
    { asOf: "2026-09-12T00:00:00Z" }, { asOf: "invalid" },
  ])("旧版本/过期/未来/无效快照重新计算：%j", async (extra) => {
    mocks.read.mockResolvedValue(snapshot(extra));
    const score = await lookupAlertFundScore("AAPL");
    expect(mocks.sec).toHaveBeenCalledOnce();
    expect(score?.total).toBe(100);
    expect(score).not.toEqual(oldScore);
  });

  it("过期快照现场刷新失败时隐藏评分，不冒充最新结果", async () => {
    mocks.read.mockResolvedValue(snapshot({ asOf: "2026-09-01T00:00:00Z" }));
    mocks.sec.mockRejectedValue(new Error("SEC 503"));
    expect(await lookupAlertFundScore("AAPL")).toBeUndefined();
  });

  it("快照请求卡住也在 2.5 秒内结束，并取消请求", async () => {
    mocks.read.mockImplementation(() => new Promise(() => {}));
    const task = lookupAlertFundScore("AAPL");
    await vi.advanceTimersByTimeAsync(2500);
    expect(await task).toBeUndefined();
    expect(mocks.read.mock.calls[0][1].aborted).toBe(true);
    expect(mocks.sec).not.toHaveBeenCalled();
  });

  it("SEC 卡住不阻塞买卖信号，评分请求可取消", async () => {
    mocks.read.mockResolvedValue(null);
    mocks.sec.mockImplementation(() => new Promise(() => {}));
    const task = lookupAlertFundScore("AAPL");
    await vi.advanceTimersByTimeAsync(2500);
    expect(await task).toBeUndefined();
    expect(mocks.sec.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("个别股票失败，其他股票仍更新；失败股票不沿用旧分并刷新时间", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.sec.mockImplementation(async (symbol) => { if (symbol === "AAPL") throw new Error("SEC 503"); return inputs; });
    const task = runFundScoreJob(["AAPL", "NVDA"]);
    await vi.runAllTimersAsync();
    const result = await task;
    expect(result.version).toBe(FUND_SCORE_VERSION);
    expect(result.rows.map((r) => r.symbol)).toEqual(["NVDA"]);
    expect(result.failures).toEqual([{ symbol: "AAPL", error: "SEC 503" }]);
    expect(mocks.write).toHaveBeenCalledWith("fund-score", result);
  });

  it("全部失败时不覆盖上次快照，也不延长有效期", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.sec.mockRejectedValue(new Error("SEC 503"));
    const task = runFundScoreJob(["AAPL"]).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    expect(await task).toBeInstanceOf(Error);
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
