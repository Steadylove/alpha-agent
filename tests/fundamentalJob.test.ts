import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fundamentalEventIds, fundamentalUniverse, parseFundamentalArgs, readFundamentalPeerDirectory, runFundamentalJob, selectFundamentalCandidates, withFundamentalLock } from "../scripts/build-fundamental-targets";
import { readLiveBooks } from "@/lib/fund/liveBooksStore";
import { readSignalPoolMembers } from "@/lib/fund/signalPool";
import { readFundamentalState } from "@/lib/fundamental/store";
import { createFundamentalProvider } from "@/lib/fundamental/providers";
import { refreshFundamentalSymbol } from "@/lib/fundamental/service";
import type { CatalystEvent, CatalystReport } from "@/lib/catalyst/types";
import type { LiveBookCache } from "@/lib/fund/liveBooksLogic";
import type { FundamentalState } from "@/lib/fundamental/types";

vi.mock("@/lib/fund/liveBooksStore", () => ({ readLiveBooks: vi.fn() }));
vi.mock("@/lib/fund/signalPool", () => ({ readSignalPoolMembers: vi.fn(), signalPoolPath: () => process.env.SIGNAL_POOL_PATH! }));
vi.mock("@/lib/fundamental/store", () => ({ readFundamentalState: vi.fn() }));
vi.mock("@/lib/fundamental/providers", () => ({ createFundamentalProvider: vi.fn() }));
vi.mock("@/lib/fundamental/service", () => ({ refreshFundamentalSymbol: vi.fn() }));
const now = new Date("2026-10-04T12:00:00.000Z");
let directory: string;
function event(overrides: Partial<CatalystEvent> = {}): CatalystEvent {
  return { id: "a".repeat(24), provider: "news", externalId: "article", sourceName: "Company", sourceUrl: "https://example.com/release", title: "Guidance update", excerpt: "Company update", type: "Guidance", importance: "high", symbols: ["AMD"], sectorIds: [], scope: "stock", publishedAt: "2026-10-03T15:00:00.000Z", eventAt: null, eventDate: "2026-10-03", timePrecision: "minute", session: "regular", timing: "confirmed", status: "published", sourceUpdatedAt: null, firstSeenAt: "2026-10-03T15:05:00.000Z", lastSeenAt: "2026-10-03T15:05:00.000Z", revision: 1, backfilled: false, firstRelations: [], currentRelations: [], relatedSourceUrls: [], ...overrides };
}
function report(events: CatalystEvent[] = []): CatalystReport {
  return { version: 1, generatedAt: now.toISOString(), asOf: "2026-10-04", sessions: [], universe: { asOf: "2026-10-04", observedAt: now.toISOString(), symbols: [], sectors: [], signals: [], health: [] }, sources: [], events, reactions: [], summary: null, summaryStatus: "not-requested", warnings: [] };
}
function state(overrides: Partial<FundamentalState> = {}): FundamentalState {
  return { version: 1, symbol: "AMD", checkedAt: "2026-10-01T12:00:00.000Z", nextCheckAt: "2026-10-03T12:00:00.000Z", status: "unavailable", reasons: [], current: null, latestQuote: null, eventIds: [], analystStatus: "not-requested", ...overrides };
}
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "fundamental-job-"));
  vi.stubEnv("MARKET_DATA_DIR", directory); vi.stubEnv("MARKET_DATA_BASE_URL", ""); vi.stubEnv("VERCEL", "");
  vi.stubEnv("SIGNAL_POOL_PATH", path.join(directory, "signal-pool.json"));
  vi.mocked(readLiveBooks).mockReset().mockResolvedValue(null);
  vi.mocked(readSignalPoolMembers).mockReset().mockResolvedValue(["AMD"]);
  vi.mocked(readFundamentalState).mockReset().mockReturnValue(null);
  vi.mocked(createFundamentalProvider).mockReset().mockReturnValue(vi.fn());
  vi.mocked(refreshFundamentalSymbol).mockReset().mockResolvedValue({ status: "updated", state: state() });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe("fundamental CLI boundaries", () => {
  it("has a bounded default and requires an explicit ticker for event review", () => {
    expect(parseFundamentalArgs([])).toEqual({ limit: 12, dryRun: false, force: false, noAi: false, reviewedEventIds: [] });
    const id = "a".repeat(24);
    expect(parseFundamentalArgs(["--symbol=amd", "--limit=3", "--dry-run", "--no-ai", "--force", `--review-event=${id}`])).toEqual({ symbol: "AMD", limit: 3, dryRun: true, force: true, noAi: true, reviewedEventIds: [id] });
    for (const args of [[`--review-event=${id}`], ["--symbol=../AMD"], ["--limit=0"], ["--limit=101"], ["--send"], ["--review-event=bad", "--symbol=AMD"]]) expect(() => parseFundamentalArgs(args)).toThrow();
  });
  it("combines the saved pool, holdings and portfolio/signal relations only", () => {
    const value = report();
    for (const [symbol, kind] of [["MSFT", "portfolio"], ["GOOG", "signal"], ["NVDA", "opportunity"], ["SPY", "market"]] as const)
      value.universe.symbols.push({ symbol, name: symbol, sectorId: null, industry: null, relations: [{ kind, key: symbol, label: symbol, asOf: "2026-10-03", observedAt: "2026-10-03T12:00:00Z" }] });
    const books = { computedAt: "2026-10-03T12:00:00Z", books: [{ view: { rows: [{ symbol: "CSCO" }] } }] } as LiveBookCache;
    expect(fundamentalUniverse(["AMD", "AMD", "../bad"], books, value, now)).toEqual(["AMD", "CSCO", "GOOG", "MSFT"]);
  });
  it("prioritizes missing state then the oldest due check, with an explicit batch cap", () => {
    const future = "2026-10-05T12:00:00Z";
    const candidates = [
      { symbol: "AMD", state: state(), eventIds: [] },
      { symbol: "GOOG", state: null, eventIds: [] },
      { symbol: "CSCO", state: state({ nextCheckAt: "2026-10-02T12:00:00Z" }), eventIds: [] },
      { symbol: "MSFT", state: state({ nextCheckAt: future }), eventIds: [] },
      { symbol: "NVDA", state: state({ nextCheckAt: future }), eventIds: ["new-event"] },
    ];
    expect(selectFundamentalCandidates(candidates, parseFundamentalArgs(["--limit=3"]), now).map(x => x.symbol)).toEqual(["GOOG", "CSCO", "AMD"]);
    expect(selectFundamentalCandidates(candidates, parseFundamentalArgs([]), now).map(x => x.symbol)).toEqual(["GOOG", "CSCO", "AMD", "NVDA"]);
  });
});

describe("fundamental event observation", () => {
  it("requires an exact ticker, published high company event, and a real publication time", () => {
    const value = report([event(), event({ id: "b".repeat(24), symbols: ["AMDQ"] }), event({ id: "c".repeat(24), status: "scheduled" }), event({ id: "d".repeat(24), importance: "medium" }), event({ id: "e".repeat(24), scope: "sector" }), event({ id: "f".repeat(24), publishedAt: null }), event({ id: "1".repeat(24), publishedAt: "2026-10-05T12:00:00Z" }), event({ id: "2".repeat(24), publishedAt: "2026-08-01T12:00:00Z" })]);
    expect(fundamentalEventIds("AMD", null, value, now)).toEqual(["a".repeat(24)]);
  });
  it("compares publication or source amendment to input time, never collection time", () => {
    const current = { input: { observedAt: "2026-10-02T12:00:00Z" } } as NonNullable<FundamentalState["current"]>;
    const value = report([event({ publishedAt: "2026-09-01T12:00:00Z", firstSeenAt: "2026-10-04T11:00:00Z" }), event({ id: "b".repeat(24), publishedAt: "2026-09-01T12:00:00Z", sourceUpdatedAt: "2026-10-03T12:00:00Z" }), event({ id: "c".repeat(24), sourceUpdatedAt: "2026-10-05T12:00:00Z" })]);
    expect(fundamentalEventIds("AMD", state({ current }), value, now)).toEqual(["b".repeat(24)]);
  });
});

describe("fundamental job execution", () => {
  it("dry-run does not acquire a lock, create snapshots or instantiate paid providers", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runFundamentalJob(parseFundamentalArgs(["--symbol=AMD", "--dry-run"]));
    expect(readdirSync(directory)).toEqual([]);
    expect(createFundamentalProvider).not.toHaveBeenCalled(); expect(refreshFundamentalSymbol).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ symbol: "AMD", status: "dry-run", reasonsCount: 3 });
  });
  it("shares one provider across a capped batch and passes missing-coverage warnings without AI when disabled", async () => {
    vi.stubEnv("FMP_API_KEY", "test-key");
    writeFileSync(process.env.SIGNAL_POOL_PATH!, "{}");
    vi.mocked(readSignalPoolMembers).mockResolvedValue(["AMD", "CSCO", "GOOG"]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runFundamentalJob(parseFundamentalArgs(["--limit=2", "--no-ai"]));
    expect(createFundamentalProvider).toHaveBeenCalledTimes(1);
    expect(createFundamentalProvider).toHaveBeenCalledWith({ peerDirectory: [] });
    expect(refreshFundamentalSymbol).toHaveBeenCalledTimes(2);
    const first = vi.mocked(refreshFundamentalSymbol).mock.calls[0];
    expect(first[0]).toBe("AMD"); expect(first[1].coverageWarnings).toContain("事件归档尚不可用，重大事件覆盖不完整"); expect(first[2].analyze).toBeUndefined();
    expect(first[2].collect).toBe(vi.mocked(refreshFundamentalSymbol).mock.calls[1][2].collect);
    expect(existsSync(path.join(directory, ".fundamental-target.lock"))).toBe(false);
  });
  it("isolates damaged ticker state and sanitizes failures while continuing other symbols", async () => {
    vi.stubEnv("FMP_API_KEY", "test-key"); writeFileSync(process.env.SIGNAL_POOL_PATH!, "{}");
    vi.mocked(readSignalPoolMembers).mockResolvedValue(["AMD", "CSCO"]);
    vi.mocked(readFundamentalState).mockImplementation(symbol => { if (symbol === "AMD") throw new Error("private-token-value"); return null; });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(runFundamentalJob(parseFundamentalArgs(["--no-ai"]))).rejects.toThrow("partial-failure");
    expect(refreshFundamentalSymbol).toHaveBeenCalledWith("CSCO", expect.anything(), expect.anything());
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-token-value");
  });
  it("refuses remote writers and unknown event acknowledgements before provider calls", async () => {
    vi.stubEnv("MARKET_DATA_BASE_URL", "https://example.com");
    await expect(runFundamentalJob(parseFundamentalArgs(["--symbol=AMD", "--dry-run"]))).rejects.toThrow("remote-writer-disabled");
    vi.stubEnv("MARKET_DATA_BASE_URL", "");
    await expect(runFundamentalJob(parseFundamentalArgs(["--symbol=AMD", `--review-event=${"a".repeat(24)}`, "--dry-run"]))).rejects.toThrow("unknown-review-event");
    expect(createFundamentalProvider).not.toHaveBeenCalled();
  });
});

describe("saved peer candidate directory", () => {
  const save = (data: unknown) => {
    mkdirSync(path.join(directory, "snapshots"), { recursive: true });
    writeFileSync(path.join(directory, "snapshots/screener.json"), JSON.stringify(data));
  };
  it("takes only validated symbol/industry seeds and discards RPS scores and ranking order", () => {
    save({ generatedAt: now.toISOString(), ranked: [
      { symbol: "MSFT", industry: "Software", rps: 99, score: 100 },
      { symbol: "ADBE", industry: " Software ", rps: 1, score: -100 },
      { symbol: "MSFT", industry: "Software" }, { symbol: "AMD", industry: "" },
      { symbol: "../BAD", industry: "Software" }, null,
    ] });
    expect(readFundamentalPeerDirectory(now)).toEqual([{ symbol: "ADBE", industry: "Software" }, { symbol: "MSFT", industry: "Software" }]);
  });
  it("rejects missing, future, stale, malformed and oversized-row snapshots", () => {
    expect(readFundamentalPeerDirectory(now)).toEqual([]);
    for (const data of [
      { generatedAt: "2026-10-05T12:00:00Z", ranked: [] },
      { generatedAt: "2026-01-01T12:00:00Z", ranked: [{ symbol: "MSFT", industry: "Software" }] },
      { generatedAt: "2026-10-03", ranked: [] },
      { generatedAt: now.toISOString(), ranked: Array.from({ length: 1001 }, () => ({ symbol: "MSFT", industry: "Software" })) },
    ]) { save(data); expect(readFundamentalPeerDirectory(now)).toEqual([]); }
    writeFileSync(path.join(directory, "snapshots/screener.json"), "invalid JSON");
    expect(readFundamentalPeerDirectory(now)).toEqual([]);
  });
  it("passes the directory to the one shared provider without expanding the valuation universe", async () => {
    save({ generatedAt: new Date().toISOString(), ranked: [{ symbol: "ADBE", industry: "Software" }] });
    vi.stubEnv("FMP_API_KEY", "test-key"); vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runFundamentalJob(parseFundamentalArgs(["--symbol=MSFT", "--no-ai"]));
    expect(createFundamentalProvider).toHaveBeenCalledExactlyOnceWith({ peerDirectory: [{ symbol: "ADBE", industry: "Software" }] });
    expect(refreshFundamentalSymbol).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refreshFundamentalSymbol).mock.calls[0][0]).toBe("MSFT");
  });
});

describe("fundamental locks and deployment integration", () => {
  it("rejects a live owner and releases its own lock after success or failure", async () => {
    const file = path.join(directory, "test.lock");
    await withFundamentalLock(async () => {
      expect(readFileSync(file, "utf8")).toBe(String(process.pid));
      await expect(withFundamentalLock(async () => null, file)).rejects.toThrow("lock-busy");
    }, file);
    expect(existsSync(file)).toBe(false);
    await expect(withFundamentalLock(async () => { throw new Error("failed"); }, file)).rejects.toThrow("failed");
    expect(existsSync(file)).toBe(false);
  });
  it("recovers only a demonstrably dead PID and does not remove an invalid owner", async () => {
    const file = path.join(directory, "test.lock");
    writeFileSync(file, "invalid");
    await expect(withFundamentalLock(async () => null, file)).rejects.toThrow("invalid-lock"); expect(existsSync(file)).toBe(true);
    writeFileSync(file, "2147483647");
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });
    await expect(withFundamentalLock(async () => "recovered", file)).resolves.toBe("recovered"); expect(existsSync(file)).toBe(false);
  });
  it("pins a separate runtime job and hourly timer without acquiring the strategy lock", () => {
    const shell = readFileSync("deploy/market-http/cron/alpha-fundamental.sh", "utf8");
    const deploy = readFileSync("deploy/market-http/deploy.sh", "utf8");
    expect(shell).toContain('$ROOT/fundamental.lock'); expect(shell).not.toContain('daily-quant.lock');
    for (const variable of ["SIGNAL_POOL_PATH", "SIGNAL_JOURNAL_DIR", "LIVE_BOOKS_PATH", "MARKET_DATA_DIR"]) expect(shell).toContain(`export ${variable}=`);
    expect(shell).toContain('runtime-env.sh'); expect(shell).toContain('jobs/build-fundamental-targets.mjs');
    expect(deploy.indexOf('$ROOT/fundamental.lock')).toBeLessThan(deploy.indexOf('$ROOT/daily-quant.lock'));
    expect(deploy).toContain("alpha-fundamental.timer");
    expect(readFileSync("scripts/build-runtime.mjs", "utf8")).toContain('"build-fundamental-targets"');
    expect(readFileSync("deploy/market-http/cron/alpha-fundamental.timer", "utf8")).toContain("*:17:00 Asia/Shanghai");
    expect(readFileSync("deploy/market-http/cron/alpha-daily-quant.sh", "utf8")).not.toContain("build-fundamental-targets");
  });
});
