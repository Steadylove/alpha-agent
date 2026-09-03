import { describe, expect, it } from "vitest";

import { aggregateTo2H, type IntradayBar } from "@/lib/data-sources/yahooIntraday";

function bar(nyHour: number, close: number): IntradayBar {
  const utc = Date.UTC(2024, 0, 3, nyHour + 5, 30);
  return { timestamp: utc / 1000, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

describe("aggregateTo2H", () => {
  it("同一交易日两根 1H 合成一根", () => {
    const out = aggregateTo2H([bar(9, 10), bar(10, 12), bar(11, 11), bar(12, 13)]);
    expect(out).toHaveLength(2);
    expect(out[0].open).toBe(10);
    expect(out[0].close).toBe(12);
    expect(out[0].high).toBe(13);
    expect(out[1].open).toBe(11);
    expect(out[1].close).toBe(13);
  });

  it("桶按墙钟固定，缺开盘那根不会让后面整体错位", () => {
    // 相对配对会把 10:30 和 11:30 并成一根（跨了 11:30 这条边界），当天之后所有 bar
    // 跟着错开一格，于是这只票的时间戳和同池其他票对不上。
    const out = aggregateTo2H([bar(10, 12), bar(11, 11), bar(12, 13), bar(13, 14)]);
    expect(out).toHaveLength(3);
    expect(out.map((b) => b.close)).toEqual([12, 13, 14]);
  });

  it("时间戳标准化到 9:30 / 11:30 / 13:30", () => {
    const out = aggregateTo2H([bar(9, 10), bar(11, 11), bar(15, 14)]);
    const et = (hour: number, minute: number) => Date.UTC(2024, 0, 3, hour + 5, minute) / 1000;
    expect(out.map((b) => b.timestamp)).toEqual([et(9, 30), et(11, 30), et(13, 30)]);
  });
});
