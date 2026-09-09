import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveMarketRevision, liveStrategyKey } from "@/lib/fund/liveBooksRevision";
import { writeManifest } from "@/lib/backtest/marketStore";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "book-revision-"));
  vi.stubEnv("MARKET_DATA_DIR", dir);
  vi.stubEnv("MARKET_DATA_BASE_URL", "");
  vi.stubEnv("VERCEL", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

describe("行情与策略版本", () => {
  it("清单记录实际 K 线时间，节假日无需猜交易日", async () => {
    mkdirSync(path.join(dir, "4h"));
    writeFileSync(path.join(dir, "4h", "AAPL.csv"), "date,open,high,low,close,volume\n2026-09-04T17:30,1,2,1,2,100\n");
    const manifest = writeManifest(dir);
    expect(manifest.timeframes["4h"].asOf).toBe("2026-09-04T17:30");
    const first = await liveMarketRevision();
    expect(first.asOf["4h"]).toBe("2026-09-04T17:30");
    expect((await liveMarketRevision()).marketRevision).toBe(first.marketRevision);
    writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify({ ...manifest, generatedAt: "2026-09-10T00:00:00Z" }));
    expect((await liveMarketRevision()).marketRevision).not.toBe(first.marketRevision);
    expect(liveStrategyKey()).toBe(liveStrategyKey());
  });

  it("没有清单的本地 CSV 更新也会改变版本", async () => {
    mkdirSync(path.join(dir, "2h"));
    const file = path.join(dir, "2h", "AAPL.csv");
    writeFileSync(file, "old\n");
    const before = await liveMarketRevision();
    writeFileSync(file, "updated data\n");
    expect((await liveMarketRevision()).marketRevision).not.toBe(before.marketRevision);
  });

  it("同步标记存在时禁止计算半套新行情", async () => {
    writeFileSync(path.join(dir, ".market-updating"), "updating\n");
    await expect(liveMarketRevision()).rejects.toThrow("正在同步");
  });

  it("远程缺清单或不可达时不取本地版本", async () => {
    writeManifest(dir);
    vi.stubEnv("MARKET_DATA_BASE_URL", "http://market.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(liveMarketRevision()).rejects.toThrow("缺少行情版本");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(liveMarketRevision()).rejects.toThrow("offline");
  });

  it("损坏清单不能标为最新", async () => {
    writeFileSync(path.join(dir, "MANIFEST.json"), '{"generatedAt":"not-a-date"}');
    await expect(liveMarketRevision()).rejects.toThrow("清单无效");
    writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify({ generatedAt: "2026-09-09T00:00:00Z", timeframes: { "4h": { asOf: 123 } } }));
    await expect(liveMarketRevision()).rejects.toThrow("截至时间无效");
  });
});
