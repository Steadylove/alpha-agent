import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFundamentalCoverageArgs, runFundamentalCoverage } from "../scripts/fundamental-coverage";
import { fundamentalFixture, fundamentalNow as now } from "./fixtures/fundamental";
import type { FundamentalProviderOptions } from "@/lib/fundamental/providers";

afterEach(() => vi.unstubAllEnvs());

describe("fundamental coverage arguments", () => {
  it("defaults to five ordinary-company targets and accepts a bounded deduplicated symbol list", () => {
    expect(parseFundamentalCoverageArgs([])).toEqual({ symbols: ["AAPL", "MSFT", "ADBE", "ORCL", "CRM"] });
    expect(parseFundamentalCoverageArgs(["--symbol= aapl,MSFT,aapl "])).toEqual({ symbols: ["AAPL", "MSFT"] });
    for (const args of [["--symbol="], ["--symbol=../AAPL"], ["--symbol=AAPL,"],
      ["--symbol=AAPL", "--send"], ["--write"], ["--symbol=" + Array(11).fill("AAPL").join(",")]])
      expect(() => parseFundamentalCoverageArgs(args)).toThrow();
  });

  it("validates programmatic targets before invoking any dependencies", async () => {
    const createProvider = vi.fn(), readDirectory = vi.fn();
    await expect(runFundamentalCoverage({ symbols: [] }, { apiKey: "private-key", createProvider, readDirectory })).rejects.toThrow();
    expect(createProvider).not.toHaveBeenCalled(); expect(readDirectory).not.toHaveBeenCalled();
  });
});

describe("read-only fundamental coverage", () => {
  it("does not instantiate providers, read peer directories or make requests without a key", async () => {
    const createProvider = vi.fn(), readDirectory = vi.fn();
    const report = await runFundamentalCoverage({ symbols: ["ACME"] }, { now, apiKey: "", createProvider, readDirectory });
    expect(report.configured).toBe(false);
    expect(report.targets[0].missing).toEqual(["FMP_API_KEY 未配置"]);
    expect(report.requests).toEqual([]);
    expect(createProvider).not.toHaveBeenCalled(); expect(readDirectory).not.toHaveBeenCalled();
  });

  it("validates real engine coverage in memory without writing state, requesting AI or exposing targets", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "fundamental-coverage-"));
    vi.stubEnv("MARKET_DATA_DIR", directory);
    vi.stubEnv("DEEPSEEK_API_KEY", "must-not-be-used");
    const peerDirectory = [{ symbol: "ACME", industry: "Software" }];
    const collect = vi.fn(async () => fundamentalFixture());
    const createProvider = vi.fn((options: FundamentalProviderOptions = {}) => {
      options.onRequest?.({ endpoint: "profile", symbol: "ACME", period: null, limit: null,
        status: "ok", httpStatus: 200, rows: 1, observedAt: now.toISOString() });
      return collect;
    });
    try {
      const report = await runFundamentalCoverage({ symbols: ["ACME"] }, { now, apiKey: "private-key", peerDirectory, createProvider });
      expect(report.readOnly).toBe(true); expect(report.analysisInvoked).toBe(false);
      expect(report.targets[0]).toMatchObject({ symbol: "ACME", status: "ready", validPeers: 3, missing: [] });
      expect(report.totals).toEqual({ ready: 1, unavailable: 0, failed: 0, rateLimited: 0, requests: 1, httpFailures: 0 });
      expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({ peerDirectory, apiKey: "private-key" }));
      expect(readdirSync(directory)).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("weightedTarget");
      expect(JSON.stringify(report)).not.toContain("private-key");
      expect(JSON.stringify(report)).not.toContain("must-not-be-used");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("preserves missing-data reasons and isolates credential-bearing errors while continuing the batch", async () => {
    const collect = vi.fn(async (symbol: string) => {
      if (symbol === "BAD") throw new Error("https://example.test?apikey=private-key");
      const input = fundamentalFixture(); input.peers = []; input.warnings = ["同业来源 HTTP 402"];
      return input;
    });
    const report = await runFundamentalCoverage({ symbols: ["BAD", "ACME"] }, { now, apiKey: "private-key",
      peerDirectory: [], createProvider: () => collect });
    expect(report.targets.map(row => row.status)).toEqual(["failed", "unavailable"]);
    expect(report.targets[1].missing.some(reason => reason.includes("同业不足"))).toBe(true);
    expect(report.targets[1].warnings).toEqual(["同业来源 HTTP 402"]);
    expect(JSON.stringify(report)).not.toContain("private-key");
    expect(JSON.stringify(report)).not.toContain("example.test");
  });

  it("reports sanitized request status using the real provider and only contacts the FMP origin", async () => {
    const fetchImpl = vi.fn(async () => new Response("apikey=private-key", { status: 402 })) as typeof fetch;
    const report = await runFundamentalCoverage({ symbols: ["ACME"] }, { now, apiKey: "private-key", fetchImpl, peerDirectory: [] });
    expect(report.requests).toHaveLength(1);
    expect(report.requests[0]).toMatchObject({ endpoint: "profile", symbol: "ACME", status: "http-error", httpStatus: 402 });
    expect(report.totals.httpFailures).toBe(1);
    const call = vi.mocked(fetchImpl).mock.calls[0];
    expect(new URL(String(call[0])).origin).toBe("https://financialmodelingprep.com");
    expect(String(call[0])).not.toContain("private-key");
    expect(JSON.stringify(report)).not.toContain("private-key");
  });

  it("rejects a different ticker returned by a provider instead of claiming coverage for the requested ticker", async () => {
    const report = await runFundamentalCoverage({ symbols: ["WRONG"] }, { now, apiKey: "key", peerDirectory: [],
      createProvider: () => async () => fundamentalFixture() });
    expect(report.targets[0].status).toBe("failed");
    expect(report.totals.ready).toBe(0);
  });

  it("identifies rate-limited and unattempted targets without issuing further requests or claiming missing data", async () => {
    const fetchImpl = vi.fn(async () => new Response("credential-bearing error", { status: 429 })) as typeof fetch;
    const report = await runFundamentalCoverage({ symbols: ["ACME", "MSFT", "AAPL"] }, {
      now, apiKey: "private-key", fetchImpl, peerDirectory: [],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.requests).toHaveLength(1);
    expect(report.requests[0].httpStatus).toBe(429);
    expect(report.targets.map(row => row.status)).toEqual(["rate-limited", "rate-limited", "rate-limited"]);
    expect(report.targets.every(row => row.missing[0].includes("本轮未完成"))).toBe(true);
    expect(report.totals).toMatchObject({ ready: 0, unavailable: 0, failed: 0, rateLimited: 3 });
    expect(JSON.stringify(report)).not.toContain("credential-bearing");
  });
});
