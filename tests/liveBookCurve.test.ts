import { describe, expect, it } from "vitest";
import { restoreBookCurve, withBookCurve } from "@/lib/fund/liveBookCurve";
import { liveBookCacheOf } from "@/lib/fund/liveBooksLogic";
import { appendBookView } from "@/lib/fund/liveBookContinuation";
import { continuousCache } from "./liveBooksFixtures";

const damaged = () => {
  const book = continuousCache().books[0];
  book.checkpoint!.dailyEquity = [{ date: "2026-01-02", v: 1.01 }, { date: "2026-09-07", v: 1.21 }, { date: "2026-09-08", v: 1.2 }];
  book.sparkline = [1.21, 1.2];
  return book;
};

describe("完整的已记账净值曲线", () => {
  it("修复只有末日的旧视图及两点迷你图，保留净值、持仓、交易和恢复状态", () => {
    const book = damaged(), original = JSON.stringify(book);
    const restored = withBookCurve(book);
    expect(restored.view.curve.map(({ date, equity }) => ({ date, v: equity }))).toEqual(book.checkpoint!.dailyEquity);
    expect(restored.sparkline).toEqual([1.01, 1.21, 1.2]);
    expect(restored.view.curve.at(-1)).toBe(book.view.curve[0]);
    expect({ ...restored.view, curve: [] }).toEqual({ ...book.view, curve: [] });
    expect(restored.checkpoint).toBe(book.checkpoint);
    expect(JSON.stringify(book)).toBe(original);
    expect(withBookCurve(restored)).toEqual(restored);
  });

  it("读缓存立即补齐，并且已完整的曲线也不会沿用错误的采样值", () => {
    const cache = continuousCache(); cache.books[0] = damaged();
    const first = liveBookCacheOf(cache)!;
    expect(first.books[0].view.curve).toHaveLength(3);
    first.books[0].sparkline = [9, 8];
    expect(liveBookCacheOf(first)!.books[0].sparkline).toEqual([1.01, 1.21, 1.2]);
  });

  it("已有点的明细保留，缺失日的买卖标记仅来自实际保存的成交", () => {
    const book = damaged();
    book.view.fills.push({ date: "2026-01-02T13:30", side: "buy", symbol: "NVDA", price: 100 });
    const restored = restoreBookCurve(book.view, book.checkpoint!);
    expect(restored.curve[0]).toMatchObject({ date: "2026-01-02", equity: 1.01, buys: ["NVDA"], sells: [], rows: [] });
    expect(restored.curve[1].buys).toEqual([]);
  });

  it("跨年续算先恢复年末净值，再计算当年收益", () => {
    const book = damaged();
    book.checkpoint!.dailyEquity.push({ date: "2026-12-31", v: 1.25 }, { date: "2027-01-04", v: 1.3 });
    book.checkpoint!.asOf = "2027-01-04T17:30"; book.checkpoint!.lastEq = 1.3;
    const next = { ...book.view, asOf: book.checkpoint!.asOf, equity: 1.3,
      curve: [{ ...book.view.curve[0], date: "2027-01-04", equity: 1.3 }] };
    const joined = appendBookView(book.view, next, book.checkpoint!);
    expect(joined.curve.map((p) => p.date)).toEqual(book.checkpoint!.dailyEquity.map((p) => p.date));
    expect(joined.stats.ytdPct).toBeCloseTo(4);
  });

  it.each(["overlap", "last", "duplicate", "empty"])("%s 净值异常时报错，不能悄悄生成错误曲线", (kind) => {
    const book = damaged(), c = book.checkpoint!;
    if (kind === "overlap") book.view.curve[0].equity = 2;
    if (kind === "last") c.dailyEquity.at(-1)!.v = 1.3;
    if (kind === "duplicate") c.dailyEquity.push({ ...c.dailyEquity[0] });
    if (kind === "empty") c.dailyEquity = [];
    expect(() => withBookCurve(book)).toThrow("曲线与已记账净值不一致");
  });

  it("尚未迁移的旧版没有恢复状态时保留原40点采样，不伪造历史日期", () => {
    const book = damaged(); delete book.checkpoint;
    book.sparkline = Array.from({ length: 40 }, (_, i) => 1 + i / 200);
    expect(withBookCurve(book)).toBe(book);
    expect(withBookCurve(book).view.curve).toHaveLength(1);
    expect(withBookCurve(book).sparkline).toHaveLength(40);
  });
});
