import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { bookCache, bookView } from "./liveBooksFixtures";
import { loadAndReconcileSignals, readTvJournalEvidence, tvJournalEvidenceOf } from "@/lib/fund/signalReconciliationStore";

const remote = vi.hoisted(() => ({ read: vi.fn(), url: vi.fn(() => null as string | null) }));
vi.mock("@/lib/fund/deskRemote", () => ({ deskRemoteUrl: remote.url, readDeskJson: remote.read }));
const signalTime = Date.parse("2026-09-28T17:30:00Z");
const now = new Date("2026-10-01T00:00:00Z");
let dir: string;
const record = () => {
  const payload = { event: "buy", symbol: "CSCO", tf: "240", kind: 1, price: 80, entrySignalTime: signalTime, barTime: signalTime,
    strategyKey: "aa-4h-v1|NASDAQ:CSCO|240|4|6|2.5|true|true|true|30|true|false", token: "never-expose-me",
    chart: { version: 1, stride: 1, bars: [[signalTime - 14_400_000, signalTime, 79, 81, 78, 80]] } };
  const id = createHash("sha256").update(JSON.stringify([payload.symbol, payload.tf, payload.strategyKey, payload.entrySignalTime])).digest("hex");
  return { version: 1, id, capturedAt: now.toISOString(), payload, privateData: "secret" };
};
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "signal-reconciliation-"));
  vi.stubEnv("SIGNAL_JOURNAL_DIR", dir); vi.stubEnv("LIVE_BOOKS_PATH", "");
  remote.url.mockReturnValue(null); remote.read.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

it("reads local immutable archives without creating or modifying files and strips payload/chart data", async () => {
  mkdirSync(path.join(dir, "signal-entries")); mkdirSync(path.join(dir, "signal-reviews"));
  const row = record(), file = path.join(dir, "signal-entries", `${row.id}.json`);
  writeFileSync(file, JSON.stringify(row));
  const before = { body: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs, paths: readdirSync(dir) };
  const result = await readTvJournalEvidence(bookCache(), now);
  expect(result).toMatchObject({ availability: "ok", truncated: false, records: [{ symbol: "CSCO", tf: "4h", kind: 1, signalBarOpenTime: "2026-09-28T13:30:00.000Z" }] });
  expect(JSON.stringify(result)).not.toContain("never-expose-me");
  expect(JSON.stringify(result)).not.toContain("chart");
  expect({ body: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs, paths: readdirSync(dir) }).toEqual(before);
  expect(remote.read).not.toHaveBeenCalled();
});

it("uses the configured account directory and marks missing/corrupt archives explicitly", async () => {
  vi.stubEnv("SIGNAL_JOURNAL_DIR", ""); vi.stubEnv("LIVE_BOOKS_PATH", path.join(dir, "live-books.json"));
  mkdirSync(path.join(dir, "signal-entries"));
  writeFileSync(path.join(dir, "signal-entries", `${"b".repeat(64)}.json`), "broken");
  expect(await readTvJournalEvidence(bookCache(), now)).toMatchObject({ availability: "partial", records: [] });
  expect(await loadAndReconcileSignals(bookCache())).toMatchObject({ availability: "partial" });
  rmSync(path.join(dir, "signal-entries"), { recursive: true });
  const report = await loadAndReconcileSignals(bookCache());
  expect(report).toMatchObject({ availability: "unavailable", rows: [] });
  expect(readdirSync(dir)).toEqual([]);
});

it("uses one bounded remote batch and returns unavailable after a timeout or malformed response", async () => {
  vi.stubEnv("SIGNAL_JOURNAL_DIR", ""); remote.url.mockReturnValue("https://desk.test");
  remote.read.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
  await expect(loadAndReconcileSignals(bookCache())).resolves.toMatchObject({ availability: "unavailable", rows: [] });
  expect(remote.read).toHaveBeenCalledTimes(1);
  expect(remote.read.mock.calls[0][0]).toContain("signal-reconciliation-evidence.json?");
  expect(remote.read.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  remote.read.mockResolvedValue({ records: "invalid" });
  await expect(loadAndReconcileSignals(bookCache())).resolves.toMatchObject({ availability: "unavailable", rows: [] });
});

it("rejects forged journal identities and does not infer clocks from compressed charts", () => {
  expect(tvJournalEvidenceOf({ ...record(), id: "b".repeat(64) })).toBeNull();
  const raw = record(); raw.payload.chart.stride = 2;
  expect(tvJournalEvidenceOf(raw)?.signalBarOpenTime).toBeUndefined();
});

it("includes older archived trades for a currently held symbol and exposes a bounded coverage", async () => {
  mkdirSync(path.join(dir, "signal-entries")); mkdirSync(path.join(dir, "signal-reviews"));
  const row = record();
  row.payload.barTime = row.payload.entrySignalTime = Date.parse("2026-06-01T17:30:00Z");
  row.id = createHash("sha256").update(JSON.stringify([row.payload.symbol, row.payload.tf, row.payload.strategyKey, row.payload.entrySignalTime])).digest("hex");
  writeFileSync(path.join(dir, "signal-entries", `${row.id}.json`), JSON.stringify(row));
  const cache = bookCache({ books: [{ tf: "4h", name: "4 小时", view: bookView({ rows: [{ symbol: "CSCO", entryPrice: 80, floatPnlPct: 0, weightPct: 10, rps: 70 }] }) }] });
  expect((await readTvJournalEvidence(cache, now)).records).toHaveLength(1);
  expect((await readTvJournalEvidence(bookCache(), now)).records).toHaveLength(0);
});

it("keeps only the most recent 400 compact records and declares truncation", async () => {
  mkdirSync(path.join(dir, "signal-entries")); mkdirSync(path.join(dir, "signal-reviews"));
  for (let i = 0; i < 405; i++) {
    const row = record(); row.payload.barTime = row.payload.entrySignalTime = signalTime + i * 1000;
    row.id = createHash("sha256").update(JSON.stringify([row.payload.symbol, row.payload.tf, row.payload.strategyKey, row.payload.entrySignalTime])).digest("hex");
    writeFileSync(path.join(dir, "signal-entries", `${row.id}.json`), JSON.stringify(row));
  }
  const result = await readTvJournalEvidence(bookCache(), now);
  expect(result).toMatchObject({ availability: "partial", truncated: true });
  expect(result.records).toHaveLength(400);
  expect(result.records[0].signalTime).toBe(new Date(signalTime + 404_000).toISOString());
  expect(result.records.at(-1)!.signalTime).toBe(new Date(signalTime + 5000).toISOString());
});

it("does not read oversized historical charts outside the requested window and declares partial coverage", async () => {
  mkdirSync(path.join(dir, "signal-entries")); mkdirSync(path.join(dir, "signal-reviews"));
  const old = record();
  old.payload.barTime = old.payload.entrySignalTime = Date.parse("2020-01-01T17:30:00Z");
  old.id = createHash("sha256").update(JSON.stringify([old.payload.symbol, old.payload.tf, old.payload.strategyKey, old.payload.entrySignalTime])).digest("hex");
  writeFileSync(path.join(dir, "signal-entries", `${old.id}.json`), JSON.stringify({ ...old, oldChartPadding: "x".repeat(3 * 1024 * 1024) }));
  const recent = record(); writeFileSync(path.join(dir, "signal-entries", `${recent.id}.json`), JSON.stringify(recent));
  const result = await readTvJournalEvidence(bookCache(), now);
  expect(result.records).toHaveLength(1);
  expect(result).toMatchObject({ availability: "partial", truncated: true });
});


it("prioritizes recent archive files and stops after the read-count budget even for old records", async () => {
  mkdirSync(path.join(dir, "signal-entries")); mkdirSync(path.join(dir, "signal-reviews"));
  for (let i = 0; i < 520; i++) {
    const old = record(); old.payload.barTime = old.payload.entrySignalTime = Date.parse("2020-01-01T17:30:00Z") + i * 1000;
    old.id = createHash("sha256").update(JSON.stringify([old.payload.symbol, old.payload.tf, old.payload.strategyKey, old.payload.entrySignalTime])).digest("hex");
    const file = path.join(dir, "signal-entries", `${old.id}.json`);
    writeFileSync(file, JSON.stringify(old)); utimesSync(file, new Date("2020-01-01"), new Date("2020-01-01"));
  }
  const recent = record(); writeFileSync(path.join(dir, "signal-entries", `${recent.id}.json`), JSON.stringify(recent));
  const result = await readTvJournalEvidence(bookCache(), now);
  expect(result.records).toHaveLength(1);
  expect(result.records[0].id).toBe(recent.id);
  expect(result).toMatchObject({ availability: "partial", truncated: true });
});

it("caps total chart bytes before parsing all historical files", async () => {
  mkdirSync(path.join(dir, "signal-entries")); mkdirSync(path.join(dir, "signal-reviews"));
  for (let i = 0; i < 18; i++) {
    const old = record(); old.payload.barTime = old.payload.entrySignalTime = Date.parse("2020-01-01T17:30:00Z") + i * 1000;
    old.id = createHash("sha256").update(JSON.stringify([old.payload.symbol, old.payload.tf, old.payload.strategyKey, old.payload.entrySignalTime])).digest("hex");
    writeFileSync(path.join(dir, "signal-entries", `${old.id}.json`), JSON.stringify({ ...old, chartPadding: "x".repeat(1024 * 1024) }));
  }
  const result = await readTvJournalEvidence(bookCache(), now);
  expect(result.records).toEqual([]);
  expect(result).toMatchObject({ availability: "partial", truncated: true });
});

it("stops metadata scanning after the deadline and marks incomplete coverage", async () => {
  mkdirSync(path.join(dir, "signal-entries")); mkdirSync(path.join(dir, "signal-reviews"));
  const recent = record(); writeFileSync(path.join(dir, "signal-entries", `${recent.id}.json`), JSON.stringify(recent));
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(1001);
  const result = await readTvJournalEvidence(bookCache(), now);
  expect(result.records).toEqual([]);
  expect(result).toMatchObject({ availability: "partial", truncated: true });
});


it("preserves numeric buy type, leaves old missing types unknown, and rejects malformed types", () => {
  expect(tvJournalEvidenceOf(record())?.kind).toBe(1);
  const other = record(); other.payload.kind = 2;
  expect(tvJournalEvidenceOf(other)?.kind).toBe(2);
  expect(tvJournalEvidenceOf({ ...other, payload: { ...other.payload, kind: undefined } })?.kind).toBeUndefined();
  expect(tvJournalEvidenceOf({ ...other, payload: { ...other.payload, kind: "2" } })).toBeNull();
  expect(tvJournalEvidenceOf({ ...other, payload: { ...other.payload, kind: 0 } })).toBeNull();
});
