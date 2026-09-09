import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poolAt, poolRevisionsOf } from "@/lib/fund/poolTimeline";
import { readSignalPool, replaceSignalPool, writeSignalPool } from "@/lib/fund/signalPool";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pool-timeline-"));
  vi.stubEnv("SIGNAL_POOL_PATH", path.join(dir, "pool.json"));
  writeFileSync(path.join(dir, "pool.json"), JSON.stringify({ members: ["AAPL"], added: [], removed: [], updatedAt: "" }));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("股票池生效时间与版本记录", () => {
  it("多次改池都保留，不追溯生效前以及保存时已开始的 K 线", async () => {
    const first = await writeSignalPool(replaceSignalPool([], ["NVDA"]), new Date("2026-09-09T15:00:00Z"));
    const second = await writeSignalPool(replaceSignalPool([], ["MSFT"]), new Date("2026-09-10T16:00:00Z"));
    expect(second.revisions?.slice(0, 2)).toEqual(first.revisions);
    expect(poolAt(second.revisions!, "2026-09-09T13:30")).toEqual(["AAPL"]);
    expect(poolAt(second.revisions!, "2026-09-09T17:30")).toEqual(["NVDA"]);
    expect(poolAt(second.revisions!, "2026-09-10T15:30")).toEqual(["NVDA"]);
    expect(poolAt(second.revisions!, "2026-09-10T17:30")).toEqual(["MSFT"]);
    expect((await readSignalPool()).revisions).toEqual(second.revisions);
  });

  it("名单没变不制造版本，清空只关闭后续开仓资格", async () => {
    const before = readFileSync(path.join(dir, "pool.json"), "utf8");
    await writeSignalPool(replaceSignalPool([], ["AAPL"]));
    expect(readFileSync(path.join(dir, "pool.json"), "utf8")).toBe(before);
    const empty = await writeSignalPool(replaceSignalPool([], []), new Date("2026-09-09T15:00:00Z"));
    expect(poolAt(empty.revisions!, "2026-09-09T17:30")).toEqual([]);
    expect(poolAt(empty.revisions!, "2026-09-09T13:30")).toEqual(["AAPL"]);
  });

  it("损坏或乱序的历史不能被默认空记录掩盖", () => {
    expect(() => poolRevisionsOf([{ id: "x", effectiveAt: "bad", members: ["AAPL"] }])).toThrow("版本记录无效");
    expect(() => poolRevisionsOf([{ id: "x", effectiveAt: "2026-09-10", members: [] }, { id: "y", effectiveAt: "2026-09-09", members: [] }])).toThrow("版本记录无效");
  });
});
