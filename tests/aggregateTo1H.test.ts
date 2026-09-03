import { describe, expect, it } from "vitest";

import {
  aggregateTo1H,
  aggregateTo2H,
  aggregateTo4H,
  type IntradayBar,
} from "@/lib/data-sources/yahooIntraday";

/** 2024-01-03 是 EST（UTC-5），美东墙钟直接加 5 小时即得 UTC。 */
function m30(nyHour: number, nyMinute: number, close: number): IntradayBar {
  const utc = Date.UTC(2024, 0, 3, nyHour + 5, nyMinute);
  return { timestamp: utc / 1000, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

const et = (hour: number, minute: number) => Date.UTC(2024, 0, 3, hour + 5, minute) / 1000;

/** 常规时段完整的一天：9:30 到 15:30，13 根 30 分钟棒。 */
const fullDay = [
  m30(9, 30, 1), m30(10, 0, 2), m30(10, 30, 3), m30(11, 0, 4), m30(11, 30, 5),
  m30(12, 0, 6), m30(12, 30, 7), m30(13, 0, 8), m30(13, 30, 9), m30(14, 0, 10),
  m30(14, 30, 11), m30(15, 0, 12), m30(15, 30, 13),
];

describe("aggregateTo1H", () => {
  it("整个常规时段切成 7 根，时间戳从 9:30 起每小时一根", () => {
    const out = aggregateTo1H(fullDay);
    expect(out.map((b) => b.timestamp)).toEqual([
      et(9, 30), et(10, 30), et(11, 30), et(12, 30), et(13, 30), et(14, 30), et(15, 30),
    ]);
  });

  it("首根覆盖 9:30–10:30 的开盘时段，不是 10:00 起", () => {
    // 直抓 Alpaca 1Hour 时，承载 9:30–10:00 的那根时间戳是 9:00，会被当成盘前丢掉，
    // 每天首根变成 10:00。这里锁住修复后的行为。
    const out = aggregateTo1H(fullDay);
    expect(out[0].timestamp).toBe(et(9, 30));
    expect(out[0].open).toBe(1);
    expect(out[0].close).toBe(2);
    expect(out[0].volume).toBe(20);
  });

  it("末根 15:30–16:00 只有半小时，单独成根", () => {
    const out = aggregateTo1H(fullDay);
    expect(out.at(-1)).toMatchObject({ timestamp: et(15, 30), open: 13, close: 13, volume: 10 });
  });

  it("桶按墙钟固定，缺开盘那根不会让后面整体错位", () => {
    const out = aggregateTo1H(fullDay.slice(1));
    expect(out[0].timestamp).toBe(et(9, 30));
    expect(out[0].close).toBe(2);
    expect(out[1].timestamp).toBe(et(10, 30));
  });
});

describe("1H / 2H / 4H 桶边界嵌套", () => {
  // 三个周期都从同一份 30 分钟棒聚合，切点必须对齐：先合成 1H 再合成 2H，
  // 结果要和直接从 30M 合成 2H 完全一致，否则同一时刻在不同周期上看到的
  // 边界不同，跨周期比较就失去意义。
  it("2H 由 1H 再聚合与直接由 30M 聚合等价", () => {
    expect(aggregateTo2H(aggregateTo1H(fullDay))).toEqual(aggregateTo2H(fullDay));
  });

  it("4H 由 1H 再聚合与直接由 30M 聚合等价", () => {
    expect(aggregateTo4H(aggregateTo1H(fullDay))).toEqual(aggregateTo4H(fullDay));
  });

  it("三个周期的桶边界层层包含", () => {
    const stamps = (bars: IntradayBar[]) => new Set(bars.map((b) => b.timestamp));
    const h1 = stamps(aggregateTo1H(fullDay));
    const h2 = stamps(aggregateTo2H(fullDay));
    const h4 = stamps(aggregateTo4H(fullDay));
    for (const t of h2) expect(h1.has(t)).toBe(true);
    for (const t of h4) expect(h2.has(t)).toBe(true);
  });
});
