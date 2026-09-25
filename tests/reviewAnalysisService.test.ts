import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildReviewAnalysis } from "@/lib/review/analysis/service";
import { analysisHash, prepareAnalysisInput } from "@/lib/review/analysis/fingerprint";
import type { AnalysisEvidence, AnalysisOutput, AnalysisReport } from "@/lib/review/analysis/types";
import type { DailyReview } from "@/lib/review/types";
import { writeSnapshot, snapshotFile } from "@/lib/vps/snapshot";
import { getReviewData } from "@/lib/review/store";
import { fetchMarketText } from "@/lib/backtest/marketRemote";

vi.mock("@/lib/backtest/marketRemote", () => ({ fetchMarketText: vi.fn() }));
let root: string;
const date = "2026-09-24";
function review(): DailyReview {
  return { version: 1, date, previousDate: "2026-09-23", builtAt: "2026-09-25T00:00:00Z",
    market: { regime: "Neutral", summary: "", metrics: [],
      breadth: { today: null, yesterday: null, valid: 0, total: 500, universe: "SP500", membershipAsOf: date },
      strongSectors: { today: null, yesterday: null, total: 11 } },
    sectors: [], options: [], signals: [], accounts: [], warnings: [] };
}
function output(evidence: AnalysisEvidence): AnalysisOutput {
  return { lead: { text: "系统保留 Neutral 状态，现有数据不足以确认指数、板块与期权结构之间的关系。信号记录和模型账户应分别理解，缺失值不能视为零；没有成熟结果时，不评价评分有效性。后续应先核对同一交易日的数据完整性，再观察各模块是否出现可比较的变化。",
    factIds: [evidence.facts[0].id] }, changes: [], divergences: [], confirmations: [], context: [], focus: [], limitations: [] };
}
const generate = vi.fn(async (evidence: AnalysisEvidence) => ({ output: output(evidence), usage: null }));
const now = () => new Date("2026-09-25T01:00:00Z");
const options = { date, apiKey: "unit-test-key" };
const readReport = () => JSON.parse(readFileSync(snapshotFile(`daily-review/analysis/${date}`), "utf8")) as AnalysisReport;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "review-analysis-"));
  vi.stubEnv("MARKET_DATA_DIR", root); vi.stubEnv("MARKET_DATA_BASE_URL", ""); vi.stubEnv("VERCEL", "");
  generate.mockReset(); generate.mockImplementation(async (e) => ({ output: output(e), usage: null }));
  vi.mocked(fetchMarketText).mockReset();
  writeSnapshot(`daily-review/${date}`, review());
  writeSnapshot("daily-review/index", { version: 1, dates: [date], latest: date, updatedAt: review().builtAt });
  writeSnapshot("daily-review/journal", { version: 1, asOf: date, builtAt: review().builtAt, signals: [] });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it("writes only independent analysis; unchanged input is cached and page never invokes model", async () => {
  const original = readFileSync(snapshotFile(`daily-review/${date}`), "utf8");
  expect((await buildReviewAnalysis(options, { generate, now })).status).toBe("generated");
  expect((await buildReviewAnalysis(options, { generate, now })).status).toBe("cached");
  const page = await getReviewData(date);
  expect(page.analysis?.status).toBe("ready");
  expect(page.review?.date).toBe(date);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(readFileSync(snapshotFile(`daily-review/${date}`), "utf8")).toBe(original);
  expect(readReport().inputHash).toBe(analysisHash(readReport().evidence));
});
it("provider errors preserve the successful edition; forced success keeps a prior edition", async () => {
  await buildReviewAnalysis(options, { generate, now });
  const first = readReport();
  generate.mockRejectedValueOnce(new Error("provider failed"));
  await expect(buildReviewAnalysis({ ...options, force: true }, { generate, now })).rejects.toThrow("provider failed");
  expect(readReport()).toEqual(first);
  await buildReviewAnalysis({ ...options, force: true }, { generate, now: () => new Date("2026-09-25T02:00:00Z") });
  const backups = path.join(root, "snapshots/daily-review/analysis/history");
  expect(readdirSync(backups)).toHaveLength(1);
  expect(JSON.parse(readFileSync(path.join(backups, readdirSync(backups)[0]), "utf8"))).toEqual(first);
});
it("rejects source changes during the paid request instead of publishing a mismatched note", async () => {
  await buildReviewAnalysis(options, { generate, now });
  const first = readReport();
  generate.mockImplementationOnce(async (e) => {
    writeSnapshot(`daily-review/${date}`, { ...review(), warnings: ["数据更新"] });
    return { output: output(e), usage: null };
  });
  await expect(buildReviewAnalysis({ ...options, force: true }, { generate, now })).rejects.toThrow("分析期间发生更新");
  expect(readReport()).toEqual(first);
  expect((await getReviewData(date)).analysis?.status).toBe("stale");
});
it("rejects invalid or absent dates, future source timestamps, and missing keys before model use", async () => {
  await expect(buildReviewAnalysis({ ...options, date: "../secrets" }, { generate, now })).rejects.toThrow("日期无效");
  await expect(buildReviewAnalysis({ ...options, date: "2026-09-25" }, { generate, now })).rejects.toThrow("缺少");
  await expect(buildReviewAnalysis({ date }, { generate, now })).rejects.toThrow("DEEPSEEK_API_KEY");
  writeSnapshot(`daily-review/${date}`, { ...review(), builtAt: "2026-09-26T00:00:00Z" });
  await expect(buildReviewAnalysis(options, { generate, now })).rejects.toThrow("缺少");
  expect(generate).not.toHaveBeenCalled();
});
it("dry-run validates inputs without a key or saved analysis", async () => {
  const result = await buildReviewAnalysis({ date, dryRun: true }, { generate, now });
  expect(result.status).toBe("dry-run");
  expect(generate).not.toHaveBeenCalled();
  expect((await getReviewData(date)).analysis?.status).toBe("missing");
});
it("corrupt/mismatched analysis cannot hide the original review or substitute another date", async () => {
  await buildReviewAnalysis(options, { generate, now });
  writeSnapshot(`daily-review/analysis/${date}`, { ...readReport(), date: "2026-09-23" });
  const page = await getReviewData(date);
  expect(page.review?.date).toBe(date);
  expect(page.analysis).toEqual({ status: "unavailable", report: null });
});
it("remote analysis outage never falls back to a local successful artifact", async () => {
  await buildReviewAnalysis(options, { generate, now });
  vi.stubEnv("MARKET_DATA_BASE_URL", "https://market.example.invalid");
  vi.mocked(fetchMarketText).mockImplementation(async (p) => {
    if (p.includes("/analysis/")) throw new Error("offline");
    if (p.endsWith("/index.json")) return JSON.stringify({ version: 1, dates: [date], latest: date });
    if (p.endsWith(`/${date}.json`)) return JSON.stringify(review());
    return "";
  });
  const page = await getReviewData(date);
  expect(page.review?.date).toBe(date);
  expect(page.analysis).toEqual({ status: "unavailable", report: null });
});
it("marks an unavailable journal archive explicitly instead of claiming complete historical coverage", () => {
  const packet = prepareAnalysisInput(review(), null);
  expect(packet.evidence.facts.find((f) => f.id === "journal.archive")?.status).toBe("missing");
  expect(packet.evidence.coverage.find((c) => c.section === "journal")?.status).not.toBe("available");
});
it("future journal growth does not invalidate an archived day's evidence", () => {
  const archive = { version: 1 as const, asOf: date, builtAt: review().builtAt, signals: [] };
  const later = { ...archive, asOf: "2026-09-25", builtAt: "2026-09-26T00:00:00Z", signals: [{
    id: "future", date: "2026-09-25", capturedAt: "2026-09-25T16:00:00Z",
  }] };
  const original = prepareAnalysisInput(review(), archive);
  // Later records are outside the evidence window and discarded before accessing their other fields.
  expect(prepareAnalysisInput(review(), later as Parameters<typeof prepareAnalysisInput>[1]).inputHash).toBe(original.inputHash);
});
