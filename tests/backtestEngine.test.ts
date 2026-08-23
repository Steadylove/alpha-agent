import { describe, expect, it } from "vitest";

import { percentileRanksFast, prepareUniverse } from "@/lib/backtest/engine";
import { packPanel, unpackPanel, type PanelBars } from "@/lib/backtest/panel";
import { deriveIntervals } from "@/lib/data-sources/sp500Historical";
import { PERCENTILE_RS_TERMS, percentileRank } from "@/lib/scoring/percentileRs";

describe("percentileRanksFast", () => {
  // 引擎里的排序实现替换了 O(n²) 的 percentileRank，必须逐位等价
  const cases: number[][] = [
    [],
    [7],
    [1, 2, 3],
    [3, 1, 2],
    [5, 5, 5, 5],
    [1, 1, 2, 2, 3],
    [-4, 0, 0, 12, -4, 7],
    [0.1, 0.100000001, 0.1],
  ];

  it.each(cases.map((c, i) => [i, c] as const))("与 percentileRank 等价 (#%i)", (_, scores) => {
    expect(Array.from(percentileRanksFast(scores))).toEqual(percentileRank(scores));
  });

  it("在 500 只的随机截面上等价", () => {
    let seed = 42;
    const scores = Array.from({ length: 500 }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      // 制造大量并列，专门压并列分支
      return Math.round((seed / 2147483648) * 20);
    });
    expect(Array.from(percentileRanksFast(scores))).toEqual(percentileRank(scores));
  });
});

describe("截面 RPS 的逐日重算", () => {
  /** 从 2000-01-03 起连续编日期，只为构造有序轴，不必是真实交易日 */
  const axisDates = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      new Date(Date.UTC(2000, 0, 3 + i)).toISOString().slice(0, 10),
    );

  /** 前半段按 firstHalf 的日涨幅走，后半段换成 secondHalf，用于制造强弱反转 */
  function panel(ticker: string, dates: string[], firstHalf: number, secondHalf: number): PanelBars {
    const close = new Float32Array(dates.length);
    let v = 100;
    for (let i = 0; i < dates.length; i += 1) {
      v *= 1 + (i < dates.length / 2 ? firstHalf : secondHalf) / 100;
      close[i] = v;
    }
    return { ticker, dates, high: close, low: close, close, volume: null };
  }

  const N = 400;
  const dates = axisDates(N);
  const all = { start: dates[0], end: null };

  it("同一只标的在不同日期拿到不同分位，强弱反转会被跟上", () => {
    // RISER 先弱后强，FADER 先强后弱，另加三只匀速股撑起截面
    const panels = [
      panel("RISER", dates, 0.01, 0.5),
      panel("FADER", dates, 0.5, 0.01),
      panel("MID1", dates, 0.2, 0.2),
      panel("MID2", dates, 0.15, 0.15),
      panel("MID3", dates, 0.25, 0.25),
    ];
    const membership = new Map(panels.map((p) => [p.ticker, [all]]));
    const u = prepareUniverse(panels, membership);
    const riser = u.symbols.find((s) => s.ticker === "RISER")!;
    const fader = u.symbols.find((s) => s.ticker === "FADER")!;

    // 刚过预热时反转尚未体现在长周期里，FADER 仍占优
    expect(fader.rps[252]).toBeGreaterThan(riser.rps[252]);
    // 到轴末端，21/63 日的大权重已把 RISER 推上去
    expect(riser.rps[N - 1]).toBeGreaterThan(fader.rps[N - 1]);
    // 「动态」的直接体现：同一只股票的分位在轴上确实变过
    expect(new Set(Array.from(riser.rps.slice(252))).size).toBeGreaterThan(1);
  });

  it("某一日的分位等于按当日四周期加权分独立排名的结果", () => {
    const panels = [
      panel("A", dates, 0.4, 0.05),
      panel("B", dates, 0.1, 0.3),
      panel("C", dates, 0.2, 0.2),
      panel("D", dates, -0.1, 0.35),
    ];
    const membership = new Map(panels.map((p) => [p.ticker, [all]]));
    const u = prepareUniverse(panels, membership);

    const at = N - 1;
    const scores = panels.map((p) =>
      PERCENTILE_RS_TERMS.reduce(
        (s, t) => s + t.weight * (p.close[at] / p.close[at - t.lookback]) * 100,
        0,
      ),
    );
    const want = percentileRank(scores);

    panels.forEach((p, i) => {
      const got = u.symbols.find((s) => s.ticker === p.ticker)!.rps[at];
      expect(got).toBeCloseTo(want[i], 4);
    });
  });

  it("预热不足 252 根的日子不评分，非成分日也不评分", () => {
    const panels = [
      panel("A", dates, 0.3, 0.3),
      panel("B", dates, 0.1, 0.1),
      panel("C", dates, 0.2, 0.2),
    ];
    // C 只在轴的后 100 天是成分股
    const membership = new Map<string, { start: string; end: string | null }[]>([
      ["A", [all]],
      ["B", [all]],
      ["C", [{ start: dates[N - 100], end: null }]],
    ]);
    const u = prepareUniverse(panels, membership);
    const a = u.symbols.find((s) => s.ticker === "A")!;
    const c = u.symbols.find((s) => s.ticker === "C")!;

    expect(a.rps[251]).toBe(0);
    expect(a.rps[252]).toBeGreaterThan(0);
    // 非成分期一律 0，即便回看已经齐了
    expect(c.rps[300 - 1]).toBe(0);
    expect(c.rps[N - 1]).toBeGreaterThan(0);
  });

  it("只在当日成分之间排名——非成分标的不参与、不改变他人分位", () => {
    const base = [panel("A", dates, 0.3, 0.3), panel("B", dates, 0.1, 0.1)];
    const intruder = panel("X", dates, 0.9, 0.9);
    const spans = new Map(base.map((p) => [p.ticker, [all]]));

    const without = prepareUniverse(base, spans);
    // X 有数据但从不是成分，加进来不应影响 A、B 的分位
    const withX = prepareUniverse(
      [...base, intruder],
      new Map([...spans, ["X", [] as { start: string; end: string | null }[]]]),
    );

    const rpsOf = (u: ReturnType<typeof prepareUniverse>, t: string) =>
      u.symbols.find((s) => s.ticker === t)!.rps[N - 1];

    expect(rpsOf(withX, "A")).toBe(rpsOf(without, "A"));
    expect(rpsOf(withX, "B")).toBe(rpsOf(without, "B"));
    expect(rpsOf(withX, "X")).toBe(0);
  });
});

describe("成分区间推导", () => {
  const snap = (date: string, tickers: string[]) => ({ date, tickers });

  it("连续出现压成一段，仍在最新快照内则右端为 null", () => {
    const intervals = deriveIntervals([
      snap("2000-01-01", ["AAA", "BBB"]),
      snap("2001-01-01", ["AAA", "BBB"]),
      snap("2002-01-01", ["AAA", "BBB"]),
    ]);
    expect(intervals).toEqual([
      { ticker: "AAA", start: "2000-01-01", end: null },
      { ticker: "BBB", start: "2000-01-01", end: null },
    ]);
  });

  it("中途离开则右端取最后一次出现的快照日", () => {
    const intervals = deriveIntervals([
      snap("2000-01-01", ["AAA", "OUT"]),
      snap("2001-01-01", ["AAA", "OUT"]),
      snap("2002-01-01", ["AAA"]),
    ]);
    expect(intervals.find((i) => i.ticker === "OUT")).toEqual({
      ticker: "OUT",
      start: "2000-01-01",
      end: "2001-01-01",
    });
  });

  it("多次进出产出多段（AMD 那种情形）", () => {
    const intervals = deriveIntervals([
      snap("2000-01-01", ["AMD"]),
      snap("2001-01-01", ["AMD"]),
      snap("2002-01-01", []),
      snap("2003-01-01", []),
      snap("2004-01-01", ["AMD"]),
    ]);
    expect(intervals).toEqual([
      { ticker: "AMD", start: "2000-01-01", end: "2001-01-01" },
      { ticker: "AMD", start: "2004-01-01", end: null },
    ]);
  });
});

describe("面板打包", () => {
  it("往返后日期完整、价格精度足够", () => {
    const bars = [
      { date: "2020-01-02", high: 100.25, low: 99.5, close: 100, volume: 1_234_567 },
      { date: "2020-01-03", high: 101.75, low: 100.1, close: 101.5, volume: 98_765_432 },
      { date: "2024-12-31", high: 4321.5, low: 4300.25, close: 4310.75, volume: 0 },
    ];
    const packed = packPanel(bars);
    const back = unpackPanel({ ticker: "T", ...packed });

    expect(back.dates).toEqual(bars.map((b) => b.date));
    expect(packed.barCount).toBe(3);
    // Float32 约 7 位有效数字，四位数价格的误差在 0.001 量级
    bars.forEach((b, i) => {
      expect(back.close[i]).toBeCloseTo(b.close, 2);
      expect(back.high[i]).toBeCloseTo(b.high, 2);
      expect(back.low[i]).toBeCloseTo(b.low, 2);
    });
    // 成交量按相对误差校验：Float32 存一亿股的绝对误差在十股量级
    bars.forEach((b, i) => {
      expect(back.volume![i]).toBeCloseTo(b.volume, b.volume > 1e6 ? -2 : 5);
    });
  });

  it("volume 缺失时返回 null，不影响价格解包", () => {
    const packed = packPanel([
      { date: "2020-01-02", high: 10, low: 9, close: 9.5, volume: 100 },
    ]);
    const back = unpackPanel({ ticker: "T", ...packed, volume: null });

    expect(back.volume).toBeNull();
    expect(back.close[0]).toBeCloseTo(9.5, 4);
  });
});
