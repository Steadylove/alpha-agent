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
});
