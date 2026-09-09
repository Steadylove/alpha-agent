import { describe, expect, it } from "vitest";

import { isLiveBookFresh, liveBookCacheOf, livePoolKey, slimLookbackView } from "@/lib/fund/liveBooksLogic";
import type { LookbackView } from "@/lib/fund/lookbackLogic";

const view = (over: Partial<LookbackView> = {}): LookbackView => ({
  since: "2026-01-01",
  asOf: "2026-09-08T17:30",
  equity: 1.2,
  pnl: "+20.0%",
  exposurePct: 90,
  curve: [],
  rows: [],
  fills: [],
  stats: {
    cagr: 30,
    dd: 10,
    mar: 3,
    entries: 8,
    rotations: 0,
    avgHoldings: 6,
    avgExposure: 80,
    tradesPerYear: 12,
    ytdYear: 2026,
    ytdPct: 20,
    winRatePct: 50,
  },
  misses: [],
  ...over,
});

const cache = {
  computedAt: "2026-09-09T07:00:00.000Z",
  epochFrom: "2026-01-01",
  poolKey: livePoolKey(["AAPL", "NVDA"]),
  slots: 10,
  books: [
    { tf: "4h" as const, name: "4 小时", view: view() },
    { tf: "2h" as const, name: "2H 扩池", view: view({ equity: 1.1, pnl: "+10.0%" }) },
  ],
};

describe("live books cache", () => {
  it("池名单排序后当指纹", () => {
    expect(livePoolKey(["nvda", "AAPL"])).toBe(livePoolKey(["AAPL", "NVDA"]));
  });

  it("缺一本或池变了就是旧缓存", () => {
    expect(isLiveBookFresh(cache, "2026-01-01", cache.poolKey, 10)).toBe(true);
    expect(isLiveBookFresh(cache, "2026-02-01", cache.poolKey, 10)).toBe(false);
    expect(isLiveBookFresh(cache, "2026-01-01", livePoolKey(["AAPL"]), 10)).toBe(false);
    expect(isLiveBookFresh({ ...cache, books: cache.books.slice(0, 1) }, "2026-01-01", cache.poolKey, 10)).toBe(
      false,
    );
  });

  it("落盘只留最后一根曲线", () => {
    const slim = slimLookbackView(
      view({
        curve: [
          { date: "2026-01-02", equity: 1.1, exposurePct: 80, rows: [], buys: ["AAPL"], sells: [], misses: [] },
          { date: "2026-09-08", equity: 1.2, exposurePct: 90, rows: [], buys: [], sells: ["NVDA"], misses: [] },
        ],
      }),
    );
    expect(slim.curve).toHaveLength(1);
    expect(slim.curve[0]?.date).toBe("2026-09-08");
    expect(slim.curve[0]?.sells).toEqual(["NVDA"]);
  });

  it("缺字段的磁盘内容当没有缓存", () => {
    expect(liveBookCacheOf({})).toBeNull();
    expect(liveBookCacheOf(cache)?.books).toHaveLength(2);
    expect(liveBookCacheOf({ ...cache, books: [{ tf: "4h", name: "4 小时" }] })).toBeNull();
  });
});
