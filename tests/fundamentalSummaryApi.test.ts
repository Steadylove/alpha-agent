import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/fundamental/summary/route";
import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { loadRuntimeConfig } from "@/lib/runtimeConfig";
import * as store from "@/lib/fundamental/store";
import type { FundamentalSummaryData } from "@/lib/fundamental/types";
import { fundamentalStateFixture, fundamentalNow as now } from "./fixtures/fundamental";

vi.mock("@/lib/backtest/marketRemote", () => ({ fetchMarketText: vi.fn() }));
vi.mock("@/lib/runtimeConfig", () => ({ loadRuntimeConfig: vi.fn(async () => {}) }));

const read = vi.mocked(fetchMarketText);
const request = (symbols: string) => new Request(`http://localhost/api/fundamental/summary?symbols=${encodeURIComponent(symbols)}`);
const rows = async (response: Response): Promise<FundamentalSummaryData[]> => (await response.json()).rows;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("MARKET_DATA_BASE_URL", "https://snapshots.example.test");
  vi.stubEnv("FUNDAMENTAL_DEMO_SYMBOLS", "");
  read.mockReset().mockResolvedValue("");
  vi.mocked(loadRuntimeConfig).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("fundamental summary API", () => {
  it("normalizes and deduplicates symbols, preserves demo and returns only compact saved fields", async () => {
    const state = fundamentalStateFixture(), current = state.current!;
    state.latestQuote = { price: 105, observedAt: now.toISOString() };
    vi.stubEnv("FUNDAMENTAL_DEMO_SYMBOLS", " acme ");
    read.mockImplementation(async name => name === "snapshots/fundamental-target/ACME/latest.json" ? JSON.stringify(state) : "");
    const response = await GET(request(" acme,ACME, msft "));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = await rows(response);
    expect(result).toEqual([
      {
        symbol: "ACME", status: "ready", reasons: [], checkedAt: state.checkedAt,
        publishedAt: current.publishedAt, method: current.method, quote: state.latestQuote, currency: "USD",
        sixMonth: { weightedTarget: current.sixMonth.weightedTarget, rangeLow: current.sixMonth.rangeLow, rangeHigh: current.sixMonth.rangeHigh },
        twelveMonth: { weightedTarget: current.twelveMonth.weightedTarget, rangeLow: current.twelveMonth.rangeLow, rangeHigh: current.twelveMonth.rangeHigh },
        demo: true,
      },
      {
        symbol: "MSFT", status: "missing", reasons: ["尚无已保存的基本面估值"],
        checkedAt: null, publishedAt: null, method: null, quote: null, currency: "", sixMonth: null, twelveMonth: null,
      },
    ]);
    expect(read.mock.calls.map(([name]) => name)).toEqual([
      "snapshots/fundamental-target/ACME/latest.json", "snapshots/fundamental-target/MSFT/latest.json",
    ]);
    expect(loadRuntimeConfig).toHaveBeenCalledOnce();
  });

  it.each(["overdue check", "expired valuation"])("preserves stale aging for %s without requesting history", async reason => {
    const state = fundamentalStateFixture();
    vi.setSystemTime(reason === "overdue check" ? new Date(now.getTime() + 49 * 3600000) : new Date(state.current!.validUntil));
    read.mockResolvedValue(JSON.stringify(state));
    const [result] = await rows(await GET(request("ACME")));
    expect(result.status).toBe("stale");
    expect(result.reasons).toContain("后台复核已超时，展示上一有效版本");
    expect(result.twelveMonth?.weightedTarget).toBe(state.current!.twelveMonth.weightedTarget);
    expect(read.mock.calls.map(([name]) => name)).toEqual(["snapshots/fundamental-target/ACME/latest.json"]);
  });

  it.each(["pending", "unavailable"] as const)("preserves %s without inventing a target or currency", async status => {
    const state = { ...fundamentalStateFixture(), status, current: null, reasons: ["缺少可核验预期"] };
    read.mockResolvedValue(JSON.stringify(state));
    const [result] = await rows(await GET(request("ACME")));
    expect(result).toMatchObject({ status, reasons: state.reasons, sixMonth: null, twelveMonth: null, currency: "" });
  });

  it("isolates malformed and failed snapshots while returning other symbols", async () => {
    const state = fundamentalStateFixture();
    read.mockImplementation(async name => {
      if (name.includes("/ACME/")) return JSON.stringify(state);
      if (name.includes("/MSFT/")) throw new Error("offline");
      return "broken json";
    });
    const response = await GET(request("ACME,MSFT,GOOG"));
    expect(response.status).toBe(200);
    const result = await rows(response);
    expect(result.map(row => row.status)).toEqual(["ready", "error", "error"]);
    for (const row of result.slice(1)) {
      expect(row.reasons.length).toBeGreaterThan(0);
      expect(row).toMatchObject({ quote: null, sixMonth: null, twelveMonth: null, publishedAt: null });
    }
  });

  it("discards targets from partial reads and catches unexpected per-symbol failures", async () => {
    vi.spyOn(store, "getFundamentalPage")
      .mockRejectedValueOnce(new Error("unexpected read failure"))
      .mockResolvedValueOnce({ symbol: "ACME", state: fundamentalStateFixture(), history: [], atEntry: null,
        entryAt: null, error: "快照读取失败", demo: true });
    const result = await rows(await GET(request("MSFT,ACME")));
    expect(result.map(row => row.status)).toEqual(["error", "error"]);
    expect(result[1]).toMatchObject({ demo: true, reasons: ["快照读取失败"], checkedAt: null, quote: null,
      publishedAt: null, method: null, sixMonth: null, twelveMonth: null });
  });

  it.each(["", "ACME,", "../ACME", "AAPL,$MSFT", Array.from({ length: 21 }, (_, index) => `S${index}`).join(",")])(
    "rejects invalid or oversized requests before reading snapshots: %s", async symbols => {
      const response = await GET(request(symbols));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(read).not.toHaveBeenCalled();
      expect(loadRuntimeConfig).not.toHaveBeenCalled();
    },
  );

  it("rejects omitted symbols", async () => {
    expect((await GET(new Request("http://localhost/api/fundamental/summary"))).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  it("caps concurrent reads at five and retains request order", async () => {
    let active = 0, maximum = 0;
    const pending: (() => void)[] = [];
    read.mockImplementation(() => new Promise(resolve => {
      active += 1;
      maximum = Math.max(maximum, active);
      pending.push(() => { active -= 1; resolve(""); });
    }));
    const symbols = Array.from({ length: 20 }, (_, index) => `S${index}`);
    const response = GET(request(symbols.join(",")));
    for (let batch = 0; batch < 4; batch += 1) {
      await vi.waitFor(() => expect(pending).toHaveLength(5));
      pending.splice(0).forEach(resolve => resolve());
    }
    expect((await rows(await response)).map(row => row.symbol)).toEqual(symbols);
    expect(maximum).toBe(5);
    expect(read).toHaveBeenCalledTimes(20);
  });

  it("leaves full page history enabled by default but skips the index for summary reads", async () => {
    const state = fundamentalStateFixture();
    read.mockImplementation(async name => name.endsWith("latest.json") ? JSON.stringify(state) : "corrupt index");
    const summary = await store.getFundamentalPage("ACME", { now, includeHistory: false });
    expect(summary.error).toBeNull();
    expect(summary.state?.status).toBe("ready");
    expect(summary.history).toEqual([]);
    expect(read.mock.calls.map(([name]) => name)).toEqual(["snapshots/fundamental-target/ACME/latest.json"]);
    read.mockClear();
    expect((await store.getFundamentalPage("ACME", { now })).error).not.toBeNull();
    expect(read.mock.calls.map(([name]) => name)).toEqual([
      "snapshots/fundamental-target/ACME/latest.json", "snapshots/fundamental-target/ACME/index.json",
    ]);
  });

  it("returns an uncached service error when runtime configuration is unavailable", async () => {
    vi.mocked(loadRuntimeConfig).mockRejectedValueOnce(new Error("configuration unavailable"));
    const response = await GET(request("ACME"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(read).not.toHaveBeenCalled();
  });
});
