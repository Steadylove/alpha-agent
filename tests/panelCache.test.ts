import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serialize } from "node:v8";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { packPanel, unpackPanel } from "@/lib/backtest/panel";
import {
  readSnapshot,
  snapshotSize,
  writeSnapshot,
  type PanelSnapshot,
} from "@/lib/backtest/panelCache";

describe("面板落盘缓存", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "panel-cache-"));
    file = path.join(dir, "nested", "panel.v8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const bars = [
    { date: "2020-01-02", high: 100.25, low: 99.5, close: 100, volume: 1_234_567 },
    { date: "2020-01-03", high: 101.75, low: 100.1, close: 101.5, volume: 98_765_432 },
    { date: "2024-12-31", high: 4321.5, low: 4300.25, close: 4310.75, volume: 0 },
  ];

  function snapshot(): PanelSnapshot {
    const packed = packPanel(bars);
    return {
      fetchedAt: "2026-08-23T11:00:00.000Z",
      panels: [
        {
          ticker: "AAA",
          days: packed.days,
          high: packed.high,
          low: packed.low,
          close: packed.close,
          volume: packed.volume,
        },
      ],
      membership: [
        {
          ticker: "AAA",
          index: "SP500",
          startDate: new Date("2010-01-04T00:00:00.000Z"),
          endDate: null,
        },
        {
          ticker: "BBB",
          index: "NDX100",
          startDate: new Date("2015-06-30T00:00:00.000Z"),
          endDate: new Date("2020-03-23T00:00:00.000Z"),
        },
      ],
    };
  }

  it("往返后二进制仍能被 unpackPanel 正确解出", () => {
    expect(writeSnapshot(file, snapshot())).toBe(true);
    const back = readSnapshot(file);
    expect(back).not.toBeNull();

    // 序列化对 Uint8Array 的 byteOffset 处理是这里唯一的真实风险点
    const panel = unpackPanel(back!.panels[0]);
    expect(panel.ticker).toBe("AAA");
    expect(panel.dates).toEqual(bars.map((b) => b.date));
    bars.forEach((b, i) => {
      expect(panel.close[i]).toBeCloseTo(b.close, 2);
      expect(panel.high[i]).toBeCloseTo(b.high, 2);
      expect(panel.low[i]).toBeCloseTo(b.low, 2);
    });
  });

  it("Date 与 null 端点往返后保持原样", () => {
    writeSnapshot(file, snapshot());
    const back = readSnapshot(file)!;

    expect(back.fetchedAt).toBe("2026-08-23T11:00:00.000Z");
    expect(back.membership[0].startDate.toISOString()).toBe("2010-01-04T00:00:00.000Z");
    expect(back.membership[0].endDate).toBeNull();
    expect(back.membership[1].endDate?.toISOString()).toBe("2020-03-23T00:00:00.000Z");
    expect(back.membership[1].index).toBe("NDX100");
  });

  it("会自动建目录，并能报出文件大小", () => {
    expect(snapshotSize(file)).toBe(0);
    writeSnapshot(file, snapshot());
    expect(snapshotSize(file)).toBeGreaterThan(0);
  });

  it("文件不存在时返回 null", () => {
    expect(readSnapshot(file)).toBeNull();
  });

  it("文件损坏时返回 null 而不抛错", () => {
    writeFileSync(path.join(dir, "broken.v8"), Buffer.from("not a v8 payload"));
    expect(readSnapshot(path.join(dir, "broken.v8"))).toBeNull();
  });

  it("版本号不符时视为未命中——缓存结构变更后不会读到旧结构", () => {
    const stale = path.join(dir, "stale.v8");
    writeFileSync(stale, serialize({ version: 999, ...snapshot() }));
    expect(readSnapshot(stale)).toBeNull();
  });

  it("写入失败时返回 false 而不抛错", () => {
    // 用已存在的文件当目录，mkdir 必然失败
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    expect(writeSnapshot(path.join(blocker, "panel.v8"), snapshot())).toBe(false);
  });
});
