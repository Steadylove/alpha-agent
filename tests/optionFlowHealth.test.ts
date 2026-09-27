import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeFlowCollection, flowChannelHealth, optionFlowHealthPath, readLocalFlowCollectionHealth, safeFlowCollectionError, writeFlowCollectionHealth } from "@/lib/optionFlow/health";
import { writeJsonAtomic } from "@/lib/files/atomicJson";

const startedAt = "2026-09-25T15:00:00.000Z", completedAt = "2026-09-25T15:00:01.000Z";
const scratch: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("independent relay collection health", () => {
  it("records successful zero-new-message checks without implying zero market activity", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flow-health-")); scratch.push(dir);
    const dataPath = path.join(dir, "option-flow.json"); vi.stubEnv("OPTION_FLOW_PATH", dataPath);
    writeJsonAtomic(dataPath, { untouched: "source facts" });
    const channel = flowChannelHealth({ channelId: "c", mode: "incremental", startedAt, completedAt, afterId: "123", raw: [] });
    const health = completeFlowCollection({ startedAt, checkedAt: completedAt, expectedChannelIds: ["c"], channels: [channel] });
    await writeFlowCollectionHealth(health);
    expect(readLocalFlowCollectionHealth()).toEqual(health);
    expect(JSON.parse(readFileSync(optionFlowHealthPath(), "utf8"))).toMatchObject({ scope: "discord-relay-poll", state: "ok", lastSuccessfulAt: completedAt, channels: [{ received: 0, oldestRelayAt: null, newestRelayAt: null, lastMessageId: "123" }] });
    expect(JSON.parse(readFileSync(dataPath, "utf8"))).toEqual({ untouched: "source facts" });
  });
  it("retains the last successful check but marks a failed or missing channel as unavailable", () => {
    const ok = flowChannelHealth({ channelId: "c", mode: "incremental", startedAt, completedAt, raw: [] });
    const previous = completeFlowCollection({ startedAt, checkedAt: completedAt, expectedChannelIds: ["c"], channels: [ok] });
    const bad = flowChannelHealth({ channelId: "c", mode: "incremental", startedAt, completedAt, failed: true, error: new Error("Discord HTTP 403 token=SECRET webhook/PRIVATE") });
    const result = completeFlowCollection({ startedAt, checkedAt: "2026-09-25T15:01:00Z", expectedChannelIds: ["c"], channels: [bad], failed: true, error: new Error("SECRET"), previous });
    expect(result).toMatchObject({ state: "unavailable", lastSuccessfulAt: completedAt, errorCode: "collection-failed" });
    expect(result.channels[0]).toMatchObject({ received: null, errorCode: "source-forbidden" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|token=/);
    expect(completeFlowCollection({ startedAt, checkedAt: completedAt, expectedChannelIds: ["c", "other"], channels: [ok] }).state).toBe("unavailable");
  });
  it("records only returned-message boundaries and request cursors, never fabricating a transaction window", () => {
    const channel = flowChannelHealth({ channelId: "c", mode: "since", since: "2026-09-12T00:00:00Z", startedAt, completedAt,
      raw: [{ id: "1", timestamp: "2026-09-24T13:00:00Z" }, { id: "2", timestamp: "2026-09-25T14:00:00Z" }, { id: "3" }] });
    expect(channel).toMatchObject({ received: 3, oldestRelayAt: "2026-09-24T13:00:00.000Z", newestRelayAt: "2026-09-25T14:00:00.000Z", lastMessageId: "3", since: "2026-09-12T00:00:00.000Z" });
    expect(safeFlowCollectionError(new Error("HTTP 429 api_key=SECRET"))).toBe("source-rate-limited");
    expect(safeFlowCollectionError(new Error("Authorization: SECRET"))).toBe("collection-failed");
  });
});
