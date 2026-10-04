import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFundamentalPage, saveFundamentalState, readFundamentalState } from "@/lib/fundamental/store";
import { fundamentalStateFixture, fundamentalNow as now } from "./fixtures/fundamental";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "fundamental-test-")); dirs.push(dir); return dir; };
afterEach(() => {
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});

describe("fundamental immutable snapshots", () => {
  it("labels explicit demo reads without changing archived estimates or labelling other tickers", async () => {
    const directory = temp(), state = fundamentalStateFixture(); saveFundamentalState(state, directory);
    vi.stubEnv("FUNDAMENTAL_DEMO_SYMBOLS", " bad/path, acme ");
    const data = await getFundamentalPage("ACME", { directory, now });
    expect(data.demo).toBe(true);
    expect(data.state!.current!.id).toBe(state.current!.id);
    expect(readFundamentalState("ACME", directory)).not.toHaveProperty("demo");
    expect((await getFundamentalPage("AAPL", { directory, now })).demo).toBeUndefined();
    vi.stubEnv("FUNDAMENTAL_DEMO_SYMBOLS", "");
    expect((await getFundamentalPage("ACME", { directory, now })).demo).toBeUndefined();
  });
  it("stores versions and reads a known-at-entry state without any regeneration", async () => {
    const directory = temp(), state = fundamentalStateFixture(); saveFundamentalState(state, directory);
    expect(readFundamentalState("ACME", directory)!.current!.id).toBe(state.current!.id);
    const data = await getFundamentalPage("ACME", { directory, now, entryAt: now.toISOString() });
    expect(data.error).toBeNull(); expect(data.atEntry!.id).toBe(state.current!.id);
    expect(data.history).toHaveLength(1);
  });
  it("never backfills an earlier signal with a later valuation", async () => {
    const directory = temp(); saveFundamentalState(fundamentalStateFixture(), directory);
    const data = await getFundamentalPage("ACME", { directory, now, entryAt: "2026-10-03T12:00:00.000Z" });
    expect(data.atEntry).toBeNull(); expect(data.state!.current).not.toBeNull();
  });
  it("does not treat a revoked/stale target as valid at a subsequent entry", async () => {
    const directory = temp(), state = fundamentalStateFixture(); saveFundamentalState(state, directory);
    const later = new Date(now.getTime() + 3600000);
    saveFundamentalState({ ...state, status: "stale", checkedAt: later.toISOString(), eventIds: ["event"] }, directory);
    const data = await getFundamentalPage("ACME", { directory, now: later, entryAt: later.toISOString() });
    expect(data.atEntry).toBeNull();
    const before = await getFundamentalPage("ACME", { directory, now: later, entryAt: now.toISOString() });
    expect(before.atEntry!.id).toBe(state.current!.id);
  });
  it("marks overdue collector state stale and refuses corrupted targets", async () => {
    const directory = temp(), state = fundamentalStateFixture(); saveFundamentalState(state, directory);
    const old = await getFundamentalPage("ACME", { directory, now: new Date(now.getTime() + 3 * 86400000) });
    expect(old.state!.status).toBe("stale");
    const file = path.join(directory, "ACME/latest.json"), raw = JSON.parse(readFileSync(file, "utf8"));
    raw.current.twelveMonth.weightedTarget = 9999; writeFileSync(file, JSON.stringify(raw));
    expect((await getFundamentalPage("ACME", { directory, now })).error).not.toBeNull();
  });
  it("does not overwrite an archived version", () => {
    const directory = temp(), state = fundamentalStateFixture(); saveFundamentalState(state, directory);
    state.current!.analyst = { generatedAt: now.toISOString(), inputHash: "x", model: "test", usage: null,
      summary: { text: "changed", sourceIds: ["financials"] }, drivers: [{ text: "driver", sourceIds: ["financials"] }], risks: [{ text: "risk", sourceIds: ["financials"] }] };
    expect(() => saveFundamentalState(state, directory)).toThrow();
  });
});
