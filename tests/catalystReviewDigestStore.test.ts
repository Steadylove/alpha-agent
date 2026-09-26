import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishCatalystReviewDigest, getCatalystReviewDigest } from "@/lib/catalyst/reviewDigestStore";
import type { CatalystReviewDigest } from "@/lib/catalyst/reviewDigest";
import type { CatalystReport } from "@/lib/catalyst/types";
import type { DailyReview } from "@/lib/review/types";
import { getReviewData } from "@/lib/review/store";
import { snapshotDir, snapshotFile, writeSnapshot } from "@/lib/vps/snapshot";
import { fetchMarketText } from "@/lib/backtest/marketRemote";

vi.mock("@/lib/backtest/marketRemote", () => ({ fetchMarketText: vi.fn() }));
const date = "2026-09-25", capturedAt = "2026-09-26T01:00:00.000Z", now = new Date(capturedAt);
let directory: string;
const review = (): DailyReview => ({ version: 1, date, previousDate: "2026-09-24", builtAt: "2026-09-26T00:30:00.000Z",
  market: { regime: "Neutral", summary: "", metrics: [], breadth: { today: null, yesterday: null, valid: 0, total: 500, universe: "SP500", membershipAsOf: date }, strongSectors: { today: null, yesterday: null, total: 11 } },
  options: [], sectors: [], signals: [], accounts: [], warnings: [] });
const digest = (): CatalystReviewDigest => ({ version: 1, reviewDate: date, reviewBuiltAt: review().builtAt, capturedAt, status: "ready", today: [], upcoming: [], warnings: [] });
const report = (): CatalystReport => ({ version: 1, generatedAt: capturedAt, asOf: date, sessions: ["2026-09-24", date, "2026-09-28"],
  universe: { asOf: date, observedAt: capturedAt, symbols: [], sectors: [], signals: [], health: ["portfolio-2h", "portfolio-4h", "signal-journal", "signal-live-archive", "opportunity"].map(id => ({ id, label: id, state: "ok", checkedAt: capturedAt, count: 0, detail: "" })) },
  sources: ["alpaca-news", "bls-calendar", "bea-calendar", "fed-calendar", "fmp-earnings", "sec-filings"].map(id => ({ id, label: id, state: "ok", checkedAt: capturedAt, count: 0, detail: "" })),
  events: [], reactions: [], summary: null, summaryStatus: "not-requested", warnings: [] });
const sidecar = () => snapshotFile(`catalyst/review/${date}`);
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "catalyst-review-"));
  vi.stubEnv("MARKET_DATA_DIR", directory); vi.stubEnv("MARKET_DATA_BASE_URL", ""); vi.stubEnv("VERCEL", "");
  vi.mocked(fetchMarketText).mockReset();
  writeSnapshot(`daily-review/${date}`, review());
  writeSnapshot("daily-review/index", { version: 1, latest: date, dates: [date], updatedAt: review().builtAt });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

describe("date-keyed publication", () => {
  it("publishes a supplement independently and leaves the original review byte-for-byte unchanged", () => {
    const original = readFileSync(snapshotFile(`daily-review/${date}`), "utf8");
    expect(publishCatalystReviewDigest(report(), snapshotDir())).toEqual({ status: "saved", date });
    const value = JSON.parse(readFileSync(sidecar(), "utf8"));
    expect(value).toMatchObject({ reviewDate: date, capturedAt, reviewBuiltAt: review().builtAt });
    expect(readFileSync(snapshotFile(`daily-review/${date}`), "utf8")).toBe(original);
  });
  it("never replaces a valid frozen edition when later events, relations or reviews change", () => {
    writeSnapshot(`catalyst/review/${date}`, digest());
    const original = readFileSync(sidecar(), "utf8");
    writeSnapshot(`daily-review/${date}`, { ...review(), warnings: ["later revision"] });
    expect(publishCatalystReviewDigest({ ...report(), generatedAt: "2026-09-27T01:00:00.000Z" })).toEqual({ status: "existing", date });
    expect(readFileSync(sidecar(), "utf8")).toBe(original);
  });
  it.each(["unavailable", "partial"])("retries an empty %s edition, then freezes a successful empty observation", status => {
    writeSnapshot(`catalyst/review/${date}`, { ...digest(), status, warnings: ["暂时不可用"] });
    expect(publishCatalystReviewDigest(report()).status).toBe("saved");
    expect(JSON.parse(readFileSync(sidecar(), "utf8")).status).toBe("ready");
    expect(publishCatalystReviewDigest(report()).status).toBe("existing");
  });
  it("waits for the matching current review and never backfills a different date", () => {
    expect(publishCatalystReviewDigest({ ...report(), asOf: "2026-09-24" }).status).toBe("waiting");
    writeSnapshot("daily-review/index", { version: 1, latest: "2026-09-28" });
    expect(publishCatalystReviewDigest(report()).status).toBe("waiting");
    expect(existsSync(sidecar())).toBe(false);
  });
  it("does not capture a review that was built after the collector cutoff", () => {
    writeSnapshot(`daily-review/${date}`, { ...review(), builtAt: "2026-09-26T02:00:00.000Z" });
    expect(publishCatalystReviewDigest(report()).status).toBe("waiting");
    expect(existsSync(sidecar())).toBe(false);
  });
  it("preserves a corrupt edition rather than silently replacing history", () => {
    writeSnapshot(`catalyst/review/${date}`, digest()); writeFileSync(sidecar(), "broken-json");
    expect(publishCatalystReviewDigest(report()).status).toBe("unavailable");
    expect(readFileSync(sidecar(), "utf8")).toBe("broken-json");
  });
});

describe("read-only review bridge", () => {
  it("reads only the requested saved date and never fetches providers or changes the original review", async () => {
    writeSnapshot(`catalyst/review/${date}`, digest());
    const noNetwork = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected external request"));
    expect(await getCatalystReviewDigest(date, now)).toMatchObject({ status: "ready", digest: { reviewDate: date } });
    expect(await getCatalystReviewDigest("2026-09-24", now)).toEqual({ status: "missing", digest: null });
    expect(noNetwork).not.toHaveBeenCalled();
  });
  it("a missing or invalid Catalyst sidecar cannot hide the original review", async () => {
    const before = readFileSync(snapshotFile(`daily-review/${date}`), "utf8");
    const missing = await getReviewData(date);
    expect(missing.review?.date).toBe(date); expect(missing.catalyst?.status).toBe("missing");
    writeSnapshot(`catalyst/review/${date}`, { ...digest(), reviewDate: "2026-09-24" });
    const broken = await getReviewData(date);
    expect(broken.review?.date).toBe(date); expect(broken.catalyst?.status).toBe("unavailable");
    expect(readFileSync(snapshotFile(`daily-review/${date}`), "utf8")).toBe(before);
  });
  it("rejects future captures, invalid dates and mismatched archives", async () => {
    writeSnapshot(`catalyst/review/${date}`, { ...digest(), capturedAt: "2026-09-27T00:00:00.000Z" });
    expect(await getCatalystReviewDigest(date, now)).toEqual({ status: "unavailable", digest: null });
    expect(await getCatalystReviewDigest("../latest", now)).toEqual({ status: "unavailable", digest: null });
  });
  it("a missing configured remote never falls back to a local copy or latest", async () => {
    writeSnapshot(`catalyst/review/${date}`, digest()); vi.stubEnv("MARKET_DATA_BASE_URL", "https://market.example.net");
    vi.mocked(fetchMarketText).mockResolvedValue("");
    expect(await getCatalystReviewDigest(date, now)).toEqual({ status: "missing", digest: null });
    expect(fetchMarketText).toHaveBeenCalledExactlyOnceWith(`snapshots/catalyst/review/${date}.json`, expect.any(AbortSignal));
  });
  it("sanitizes a remote failure and accepts a valid saved response", async () => {
    vi.stubEnv("MARKET_DATA_BASE_URL", "https://market.example.net");
    vi.mocked(fetchMarketText).mockRejectedValueOnce(new Error("provider-private-response"));
    expect(await getCatalystReviewDigest(date, now)).toEqual({ status: "unavailable", digest: null });
    vi.mocked(fetchMarketText).mockResolvedValue(JSON.stringify(digest()));
    expect(await getCatalystReviewDigest(date, now)).toEqual({ status: "ready", digest: digest() });
  });
});
