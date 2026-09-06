import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseCsvText, readCsvPanel, writeCsvPanel } from "@/lib/backtest/csvPanel";
import { loadMarketPanel } from "@/lib/backtest/marketRemote";
import { describe, expect, it } from "vitest";

describe("csvPanel", () => {
  it("往返后日期与价格一致，读入 Float32", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "csv-panel-"));
    try {
      const bars = [
        { date: "2020-01-02", open: 99.75, high: 100.25, low: 99.5, close: 100, volume: 1_234_567 },
        { date: "2020-01-03", open: 100.5, high: 101.75, low: 100.1, close: 101.5, volume: 98_765 },
      ];
      writeCsvPanel(dir, "TEST", bars);
      const back = readCsvPanel(dir, "TEST");
      expect(back).not.toBeNull();
      expect(back!.dates).toEqual(["2020-01-02", "2020-01-03"]);
      expect(back!.close[0]).toBeCloseTo(100, 4);
      expect(back!.open![1]).toBeCloseTo(100.5, 4);
      expect(back!.volume![0]).toBeCloseTo(1_234_567, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseCsvText 丢掉坏行", () => {
    const panel = parseCsvText(
      "X",
      "date,open,high,low,close,volume\n2020-01-02,1,1,1,1,1\nbad,row\n2020-01-03,2,2,2,2,2\n",
    );
    expect(panel?.dates).toEqual(["2020-01-02", "2020-01-03"]);
    expect(panel?.close[1]).toBeCloseTo(2, 4);
  });

  it("loadMarketPanel 读本地 CSV", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "csv-panel-"));
    const prev = process.env.MARKET_DATA_DIR;
    try {
      process.env.MARKET_DATA_DIR = dir;
      writeCsvPanel(path.join(dir, "1d"), "AAPL", [
        { date: "2020-01-02", open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { date: "2020-01-03", open: 2, high: 2, low: 2, close: 2, volume: 2 },
      ]);
      const panel = await loadMarketPanel("1d", "AAPL");
      expect(panel?.dates).toEqual(["2020-01-02", "2020-01-03"]);
    } finally {
      if (prev === undefined) delete process.env.MARKET_DATA_DIR;
      else process.env.MARKET_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("缺文件返回 null，坏行丢弃", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "csv-panel-"));
    try {
      writeCsvPanel(dir, "BAD", [
        { date: "2020-01-02", open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ]);
      expect(readCsvPanel(dir, "NOPE")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
