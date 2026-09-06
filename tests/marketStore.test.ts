import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildManifest, marketBaseUrl, writeManifest } from "@/lib/backtest/marketStore";
import { afterEach, describe, expect, it } from "vitest";

describe("market store layout", () => {
  const prev = {
    MARKET_DATA_BASE_URL: process.env.MARKET_DATA_BASE_URL,
    VERCEL: process.env.VERCEL,
  };

  afterEach(() => {
    if (prev.MARKET_DATA_BASE_URL === undefined) delete process.env.MARKET_DATA_BASE_URL;
    else process.env.MARKET_DATA_BASE_URL = prev.MARKET_DATA_BASE_URL;
    if (prev.VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prev.VERCEL;
  });

  it("Vercel 未设 URL 时默认走行情机", () => {
    delete process.env.MARKET_DATA_BASE_URL;
    process.env.VERCEL = "1";
    expect(marketBaseUrl()).toBe("http://108.174.50.53:8787");
  });

  it("counts csv files and writes MANIFEST.json", () => {
    const root = mkdtempSync(path.join(tmpdir(), "market-"));
    try {
      mkdirSync(path.join(root, "1d"), { recursive: true });
      mkdirSync(path.join(root, "4h"), { recursive: true });
      writeFileSync(path.join(root, "1d", "AAPL.csv"), "date,open,high,low,close,volume\n");
      writeFileSync(path.join(root, "4h", "AAPL.csv"), "date,open,high,low,close,volume\n");
      const manifest = writeManifest(root);
      expect(manifest.timeframes["1d"]?.files).toBe(1);
      expect(manifest.timeframes["4h"]?.files).toBe(1);
      expect(JSON.parse(readFileSync(path.join(root, "MANIFEST.json"), "utf8")).root).toBe(root);
      expect(buildManifest(root).rps.scale).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs and unpacks the canonical tree", () => {
    const src = mkdtempSync(path.join(tmpdir(), "market-src-"));
    const dest = mkdtempSync(path.join(tmpdir(), "market-dst-"));
    const archive = path.join(tmpdir(), `market-pack-${process.pid}.tar.gz`);
    try {
      mkdirSync(path.join(src, "1d"), { recursive: true });
      mkdirSync(path.join(src, "4h"), { recursive: true });
      mkdirSync(path.join(src, "2h"), { recursive: true });
      mkdirSync(path.join(src, "1h"), { recursive: true });
      mkdirSync(path.join(src, "rps"), { recursive: true });
      writeFileSync(path.join(src, "1d", "AAPL.csv"), "date,open,high,low,close,volume\n");
      writeManifest(src);
      const packed = spawnSync("tar", ["-C", src, "-czf", archive, "1d", "4h", "2h", "1h", "rps", "MANIFEST.json"]);
      expect(packed.status).toBe(0);
      const unpacked = spawnSync("tar", ["-C", dest, "-xzf", archive]);
      expect(unpacked.status).toBe(0);
      expect(existsSync(path.join(dest, "1d", "AAPL.csv"))).toBe(true);
      expect(existsSync(path.join(dest, "MANIFEST.json"))).toBe(true);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
      rmSync(archive, { force: true });
    }
  });
});
