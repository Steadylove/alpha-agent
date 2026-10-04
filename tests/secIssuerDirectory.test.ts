import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotFile } from "@/lib/vps/snapshot";
import { readSecIssuerDirectory, writeSecIssuerDirectory, type SecIssuerDirectoryEntry } from "@/lib/fundamental/secIssuerDirectory";

const now = new Date("2026-10-04T12:00:00.000Z"), day = 86400000;
let directory: string;
beforeEach(() => { directory = mkdtempSync(path.join(os.tmpdir(), "sec-issuer-directory-")); vi.stubEnv("MARKET_DATA_DIR", directory); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
const entry = (symbol = "AAPL", changes: Partial<SecIssuerDirectoryEntry> = {}): SecIssuerDirectoryEntry => ({
  symbol, cik: "0000320193", sic: 3571, observedAt: now.toISOString(),
  sourceUrl: "https://data.sec.gov/submissions/CIK0000320193.json", ...changes,
});
const file = () => snapshotFile("fundamental-sec-issuers");
function seed(records: unknown[], generatedAt = now.toISOString()) {
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify({ version: 1, generatedAt, records }));
}

describe("SEC issuer candidate directory", () => {
  it("is read-only when missing and returns an alphabetical copy independent of stored order", () => {
    expect(readSecIssuerDirectory(now)).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
    seed([entry("ZZZ"), entry("AAA"), entry("MMM")]);
    const before = readFileSync(file(), "utf8");
    expect(readSecIssuerDirectory(now).map(row => row.symbol)).toEqual(["AAA", "MMM", "ZZZ"]);
    expect(readFileSync(file(), "utf8")).toBe(before);
  });

  it("filters stale and future observations while preserving the 90-day boundary", () => {
    seed([entry("OLD", { observedAt: new Date(now.getTime() - 90 * day - 1).toISOString() }),
      entry("EDGE", { observedAt: new Date(now.getTime() - 90 * day).toISOString() }),
      entry("FUTURE", { observedAt: new Date(now.getTime() + 1).toISOString() }), entry("CURRENT")]);
    expect(readSecIssuerDirectory(now).map(row => row.symbol)).toEqual(["CURRENT", "EDGE"]);
    seed([entry()], new Date(now.getTime() + 1).toISOString());
    expect(readSecIssuerDirectory(now)).toEqual([]);
    seed([entry()], new Date(now.getTime() - 90 * day - 1).toISOString());
    expect(readSecIssuerDirectory(now)).toEqual([]);
  });

  it("accepts only a matching official submissions URL and valid issuer fields", () => {
    seed([entry("GOOD"), entry("BADCIK", { cik: "320193" }), entry("ZERO", { cik: "0000000000" }),
      entry("WRONG", { sourceUrl: "https://data.sec.gov/submissions/CIK0001321655.json" }),
      entry("HOST", { sourceUrl: "https://data.sec.gov.evil.test/submissions/CIK0000320193.json" }),
      entry("QUERY", { sourceUrl: "https://data.sec.gov/submissions/CIK0000320193.json?source=x" }),
      entry("USER", { sourceUrl: "https://name@data.sec.gov/submissions/CIK0000320193.json" }),
      entry("SIC", { sic: 0 }), entry("FRACTION", { sic: 3674.5 }), entry("bad/path")]);
    expect(readSecIssuerDirectory(now).map(row => row.symbol)).toEqual(["GOOD"]);
  });

  it("merges newer observations, keeps unrelated records and does not mutate a caller's frozen round", () => {
    const yesterday = new Date(now.getTime() - day).toISOString();
    writeSecIssuerDirectory([entry("AAPL", { observedAt: yesterday }), entry("UNCHANGED")], now);
    const frozen = readSecIssuerDirectory(now);
    const written = writeSecIssuerDirectory([entry("AAPL", { sic: 3674 }), entry("NEW")], now);
    expect(written.map(row => row.symbol)).toEqual(["AAPL", "NEW", "UNCHANGED"]);
    expect(written[0].sic).toBe(3674);
    expect(frozen.find(row => row.symbol === "AAPL")?.sic).toBe(3571);
    expect(readSecIssuerDirectory(now)).toEqual(written);
    expect(readdirSync(path.dirname(file()))).toEqual(["fundamental-sec-issuers.json"]);
  });

  it("drops equal-time conflicts regardless of record order, but accepts identical duplicates", () => {
    for (const rows of [[entry(), entry("AAPL", { sic: 3674 })], [entry("AAPL", { sic: 3674 }), entry()]]) {
      seed(rows); expect(readSecIssuerDirectory(now)).toEqual([]);
    }
    seed([entry(), entry()]); expect(readSecIssuerDirectory(now)).toEqual([entry()]);
    expect(writeSecIssuerDirectory([entry("AAPL", { sic: 3674 })], now)).toEqual([]);
    seed([entry(), entry("AAPL", { cik: "0001321655", sourceUrl: "https://data.sec.gov/submissions/CIK0001321655.json" })]);
    expect(readSecIssuerDirectory(now)).toEqual([]);
  });

  it("compares equivalent time zones as the same observation and does not restore an older conflicting row", () => {
    seed([entry(), entry("AAPL", { sic: 3674, observedAt: "2026-10-04T08:00:00-04:00" }),
      entry("AAPL", { observedAt: "2026-10-03T12:00:00Z" })]);
    expect(readSecIssuerDirectory(now)).toEqual([]);
  });

  it("rejects oversized or malformed snapshots without writing", () => {
    seed(Array.from({ length: 1001 }, () => entry())); expect(readSecIssuerDirectory(now)).toEqual([]);
    writeFileSync(file(), " ".repeat(2 * 1024 * 1024 + 1)); expect(readSecIssuerDirectory(now)).toEqual([]);
    writeFileSync(file(), "{broken"); expect(readSecIssuerDirectory(now)).toEqual([]);
  });

  it("rejects an oversized write before replacing the previous valid snapshot", () => {
    writeSecIssuerDirectory([entry()], now); const before = readFileSync(file(), "utf8");
    expect(() => writeSecIssuerDirectory(Array.from({ length: 1001 }, (_, index) => entry(`S${index}`)), now)).toThrow();
    expect(readFileSync(file(), "utf8")).toBe(before);
    expect(() => writeSecIssuerDirectory(Array.from({ length: 1000 }, (_, index) => entry(`S${index}`)), now)).toThrow();
    expect(readFileSync(file(), "utf8")).toBe(before);
  });
});
