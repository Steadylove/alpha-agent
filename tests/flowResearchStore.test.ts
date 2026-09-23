import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/backtest/marketRemote", () => ({
  fetchMarketText: vi.fn(async () => ""),
  loadMarketPanel: vi.fn(async (_tf: string, ticker: string) => ({ ticker, dates: ["2026-09-08", "2026-09-09"],
    open: Float32Array.from([100, 100]), close: Float32Array.from([100, 102]), high: Float32Array.from([101, 103]), low: Float32Array.from([99, 99]), volume: null })),
}));
vi.mock("@/lib/backtest/mergeBars", () => ({ lastSettledSession: () => "2026-09-09" }));
import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { archiveFlowResearch, getFlowResearchPage } from "@/lib/optionFlow/research/store";

let root = "";
function seed(premium: number) {
  writeFileSync(path.join(root, "flow.json"), JSON.stringify({ updatedAt: "2026-09-10T01:00:00Z", posts: [{ id: "1", tweetId: "1", handle: "FL0WG0D", kind: "flow",
    postedAt: "2026-09-08T15:00:00Z", ingestedAt: "2026-09-08T15:01:00Z", thesis: "Call buyer", rawText: "Call buyer",
    legs: [{ ticker: "AAA", right: "call", premiumUsd: premium }], imageUrls: [], imageProxyUrls: [] }] }));
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "flow-research-"));
  vi.stubEnv("MARKET_DATA_DIR", root); vi.stubEnv("OPTION_FLOW_PATH", path.join(root, "flow.json"));
  vi.stubEnv("MARKET_DATA_BASE_URL", ""); vi.stubEnv("VERCEL", "");
  vi.mocked(fetchMarketText).mockReset(); vi.mocked(fetchMarketText).mockResolvedValue("");
  seed(1000);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("research archive integrity", () => {
  it("normal reruns freeze reports; explicit rebuild backs up before replacing", async () => {
    await archiveFlowResearch();
    seed(9000); await archiveFlowResearch();
    const file = path.join(root, "snapshots/flow-research/2026-09-08.json");
    expect(JSON.parse(readFileSync(file, "utf8")).report.totals.premium).toBe(1000);
    await archiveFlowResearch(false, true);
    expect(JSON.parse(readFileSync(file, "utf8")).report.totals.premium).toBe(9000);
    const backups = path.join(root, "snapshots/flow-research/backups");
    const prior = path.join(backups, readdirSync(backups)[0], "2026-09-08.json");
    expect(JSON.parse(readFileSync(prior, "utf8")).report.totals.premium).toBe(1000);
  });
  it("shows archived dates, rejects invalid dates and marks stale latest archives", async () => {
    await archiveFlowResearch();
    expect((await getFlowResearchPage("2026-09-08")).report?.date).toBe("2026-09-08");
    expect((await getFlowResearchPage()).error).toContain("等待收盘任务更新");
    expect((await getFlowResearchPage("2026-99-99")).report).toBeNull();
    expect((await getFlowResearchPage("../../private")).report).toBeNull();
  });
  it("remote failures never fall back to existing local reports", async () => {
    await archiveFlowResearch();
    vi.stubEnv("MARKET_DATA_BASE_URL", "https://example.invalid");
    vi.mocked(fetchMarketText).mockRejectedValue(new Error("data service unavailable"));
    const result = await getFlowResearchPage();
    expect(result.report).toBeNull();
    expect(result.error).toContain("data service unavailable");
  });
});
