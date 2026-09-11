import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readSnapshot, writeSnapshot } from "@/lib/vps/snapshot";

it("快照写入失败保留完整的旧版本，不留下半个 JSON", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "alpha-snapshot-"));
  vi.stubEnv("MARKET_DATA_DIR", root);
  vi.stubEnv("MARKET_DATA_BASE_URL", "");
  vi.stubEnv("VERCEL", "");
  try {
    writeSnapshot("fund-score", { version: 2, rows: [1] });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(() => writeSnapshot("fund-score", circular)).toThrow();
    expect(await readSnapshot("fund-score")).toEqual({ version: 2, rows: [1] });
    expect(readdirSync(path.join(root, "snapshots"))).toEqual(["fund-score.json"]);
  } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
