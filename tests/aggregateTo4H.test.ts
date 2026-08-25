import { describe, expect, it } from "vitest";

import { aggregateTo4H, type IntradayBar } from "@/lib/data-sources/yahooIntraday";

/** 2024-01-03 是周三，美东 EST = UTC-5。 */
function nyBar(hour: number, minute: number, close: number): IntradayBar {
  const utc = Date.UTC(2024, 0, 3, hour + 5, minute);
  return { timestamp: utc / 1000, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

describe("aggregateTo4H", () => {
  it("Yahoo 式 1H：9:30–13:30 / 13:30–16:00", () => {
    const out = aggregateTo4H([
      nyBar(9, 30, 10),
      nyBar(10, 30, 11),
      nyBar(11, 30, 12),
      nyBar(12, 30, 13),
      nyBar(13, 30, 14),
      nyBar(14, 30, 15),
      nyBar(15, 30, 16),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].open).toBe(10);
    expect(out[0].close).toBe(13);
    expect(out[1].open).toBe(14);
    expect(out[1].close).toBe(16);
  });

  it("30Min：13:00 归上午，13:30 归下午", () => {
    const out = aggregateTo4H([
      nyBar(9, 30, 10),
      nyBar(12, 30, 12),
      nyBar(13, 0, 13),
      nyBar(13, 30, 14),
      nyBar(15, 30, 16),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].close).toBe(13);
    expect(out[1].open).toBe(14);
    expect(out[1].close).toBe(16);
    expect(out[0].timestamp).toBe(nyBar(9, 30, 10).timestamp);
    expect(out[1].timestamp).toBe(nyBar(13, 30, 14).timestamp);
  });

  it("上午缺 9:30 时时间戳仍钉在 9:30", () => {
    const out = aggregateTo4H([nyBar(10, 0, 11), nyBar(12, 30, 13), nyBar(14, 0, 15)]);
    expect(out[0].timestamp).toBe(nyBar(9, 30, 0).timestamp);
    expect(out[1].timestamp).toBe(nyBar(13, 30, 0).timestamp);
  });
});
