import { describe, expect, it } from "vitest";

import {
  allocateNameWeights,
  DEFAULT_BACKTEST_CONFIG,
  percentileRanksFast,
  prepareUniverse,
  runBacktest,
} from "@/lib/backtest/engine";
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
    return { ticker, dates, high: close, low: close, close, volume: null, open: null };
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
      { date: "2020-01-02", open: 99.75, high: 100.25, low: 99.5, close: 100, volume: 1_234_567 },
      { date: "2020-01-03", open: 100.5, high: 101.75, low: 100.1, close: 101.5, volume: 98_765_432 },
      { date: "2024-12-31", open: 4305.5, high: 4321.5, low: 4300.25, close: 4310.75, volume: 0 },
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
      expect(back.open![i]).toBeCloseTo(b.open, 2);
    });
    // 成交量按相对误差校验：Float32 存一亿股的绝对误差在十股量级
    bars.forEach((b, i) => {
      expect(back.volume![i]).toBeCloseTo(b.volume, b.volume > 1e6 ? -2 : 5);
    });
  });

  it("volume 与 open 缺失时返回 null，不影响价格解包", () => {
    const packed = packPanel([
      { date: "2020-01-02", open: 9.2, high: 10, low: 9, close: 9.5, volume: 100 },
    ]);
    const back = unpackPanel({ ticker: "T", ...packed, volume: null, open: null });

    expect(back.volume).toBeNull();
    expect(back.open).toBeNull();
    expect(back.close[0]).toBeCloseTo(9.5, 4);
  });
});

describe("RSI / Vegas / RPS 定权重", () => {
  const axisDates = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      new Date(Date.UTC(2000, 0, 3 + i)).toISOString().slice(0, 10),
    );

  function rising(ticker: string, dates: string[], start = 50, step = 0.4): PanelBars {
    const n = dates.length;
    const close = new Float32Array(n);
    const high = new Float32Array(n);
    const low = new Float32Array(n);
    const open = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const c = start + step * i;
      close[i] = c;
      open[i] = c;
      high[i] = c * 1.01;
      low[i] = c * 0.99;
    }
    return { ticker, dates, high, low, close, volume: null, open };
  }

  it("上升序列在短周期 Vegas 播种后为真，下跌序列为假", () => {
    const dates = axisDates(40);
    const up = rising("UP", dates, 50, 1);
    const down = rising("DN", dates, 90, -1);
    const all = { start: dates[0], end: null };
    const u = prepareUniverse([up, down], new Map([
      ["UP", [all]],
      ["DN", [all]],
    ]), { fast: [3, 4], slow: [8, 9] });

    const upSym = u.symbols.find((s) => s.ticker === "UP")!;
    const dnSym = u.symbols.find((s) => s.ticker === "DN")!;
    expect(upSym.vegasOk[7]).toBe(0);
    expect(upSym.vegasOk[39]).toBe(1);
    expect(dnSym.vegasOk[39]).toBe(0);
    expect(upSym.rsi14[20]).toBeGreaterThan(50);
  });

  it("rpsWeightPower=0 与等权净值逐位相同", () => {
    const dates = axisDates(320);
    const panels = [rising("A", dates, 80, 0.2), rising("B", dates, 80, 0.15), rising("C", dates, 80, 0.1)];
    const all = { start: dates[0], end: null };
    const u = prepareUniverse(panels, new Map(panels.map((p) => [p.ticker, [all]])));

    for (const sym of u.symbols) {
      sym.buy1[280] = 1;
      if (sym.ticker === "A") sym.rps[280] = 90;
      else if (sym.ticker === "B") sym.rps[280] = 40;
      else sym.rps[280] = 20;
    }

    const base = {
      ...DEFAULT_BACKTEST_CONFIG,
      from: dates[260],
      to: dates[319],
      splitDate: "2099-01-01",
      rpsMin: 0,
      useBuy1: true,
      useBuy2: false,
    };
    const eq = runBacktest(u, { ...base, rpsWeightPower: null });
    const p0 = runBacktest(u, { ...base, rpsWeightPower: 0 });

    expect(p0.inSample.portfolio.equity).toBeCloseTo(eq.inSample.portfolio.equity, 10);
    expect(p0.equity.map((e) => e.strategy)).toEqual(eq.equity.map((e) => e.strategy));

    const lastHold = p0.holdings[p0.holdings.length - 1];
    expect(lastHold).toBeDefined();
    const weightSum = lastHold.rows.reduce((a, r) => a + r.weightPct, 0);
    expect(weightSum).toBeCloseTo(100, 6);
    expect(p0.ytd).not.toBeNull();
    expect(p0.book.length).toBe(p0.equity.length);
  });

  it("maxHoldings 同日只留 RPS 最高的 N 只", () => {
    const dates = axisDates(320);
    const panels = [
      rising("A", dates, 80, 0.2),
      rising("B", dates, 80, 0.15),
      rising("C", dates, 80, 0.1),
    ];
    const all = { start: dates[0], end: null };
    const u = prepareUniverse(panels, new Map(panels.map((p) => [p.ticker, [all]])));
    for (const sym of u.symbols) {
      sym.buy1[280] = 1;
      if (sym.ticker === "A") sym.rps[280] = 90;
      else if (sym.ticker === "B") sym.rps[280] = 70;
      else sym.rps[280] = 40;
    }

    const base = {
      ...DEFAULT_BACKTEST_CONFIG,
      from: dates[260],
      to: dates[319],
      splitDate: "2099-01-01",
      rpsMin: 0,
      useBuy1: true,
      useBuy2: false,
      rpsWeightPower: 1,
    };
    const uncapped = runBacktest(u, base);
    const capped = runBacktest(u, { ...base, maxHoldings: 2 });
    const lastUn = uncapped.holdings[uncapped.holdings.length - 1];
    const lastCap = capped.holdings[capped.holdings.length - 1];
    expect(lastUn.rows.map((r) => r.symbol).sort()).toEqual(["A", "B", "C"]);
    expect(lastCap.rows.map((r) => r.symbol).sort()).toEqual(["A", "B"]);
    expect(capped.book[capped.book.length - 1].nHold).toBe(2);
  });

  it("allocateNameWeights 先按相对大小分配再封顶", () => {
    expect(allocateNameWeights([0.9], 0.15)).toEqual([0.15]);
    expect(allocateNameWeights([0.9, 0.45], null)[0]).toBeCloseTo(0.9 / 1.35, 8);
    const eight = allocateNameWeights([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.4, 0.4], 0.15);
    expect(eight[0]).toBeCloseTo(0.15, 8);
    expect(eight[1]).toBeCloseTo(0.15, 8);
    expect(eight[2]).toBeCloseTo(0.7 / 4.7, 8);
    expect(eight[5]).toBeCloseTo(0.4 / 4.7, 8);
    expect(eight[0]).toBeGreaterThan(eight[5]);
  });

  it("maxNameWeight 把单票压在净值上限内", () => {
    const dates = axisDates(320);
    const panels = [rising("A", dates, 80, 0.2), rising("B", dates, 80, 0.15)];
    const all = { start: dates[0], end: null };
    const u = prepareUniverse(panels, new Map(panels.map((p) => [p.ticker, [all]])));
    const a = u.symbols.find((s) => s.ticker === "A")!;
    a.buy1[280] = 1;
    a.rps[280] = 90;
    u.symbols.find((s) => s.ticker === "B")!.rps[280] = 20;

    const result = runBacktest(u, {
      ...DEFAULT_BACKTEST_CONFIG,
      from: dates[260],
      to: dates[319],
      splitDate: "2099-01-01",
      rpsMin: 0,
      useBuy1: true,
      useBuy2: false,
      rpsWeightPower: 1,
      maxNameWeight: 0.15,
    });
    const last = result.holdings[result.holdings.length - 1];
    expect(last.rows).toHaveLength(1);
    expect(last.rows[0].weightPct).toBeCloseTo(15, 6);
    expect(result.book[result.book.length - 1].exposurePct).toBeCloseTo(15, 6);
  });

  it("maxNameWeight 在缩仓之后封顶，RPS 高的仍更重", () => {
    const dates = axisDates(320);
    const tickers = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const rps = [90, 80, 70, 60, 50, 40, 40, 40];
    const panels = tickers.map((t) => rising(t, dates, 80, 0.15));
    const all = { start: dates[0], end: null };
    const u = prepareUniverse(panels, new Map(panels.map((p) => [p.ticker, [all]])));
    for (const [i, t] of tickers.entries()) {
      const sym = u.symbols.find((s) => s.ticker === t)!;
      sym.buy1[280] = 1;
      sym.rps[280] = rps[i];
    }
    const result = runBacktest(u, {
      ...DEFAULT_BACKTEST_CONFIG,
      from: dates[260],
      to: dates[319],
      splitDate: "2099-01-01",
      rpsMin: 0,
      useBuy1: true,
      useBuy2: false,
      rpsWeightPower: 1,
      maxNameWeight: 0.15,
    });
    const last = result.holdings[result.holdings.length - 1];
    const by = Object.fromEntries(last.rows.map((r) => [r.symbol, r.weightPct]));
    expect(by.A).toBeCloseTo(15, 5);
    expect(by.B).toBeCloseTo(15, 5);
    expect(by.C).toBeCloseTo((0.7 / 4.7) * 100, 5);
    expect(by.F).toBeCloseTo((0.4 / 4.7) * 100, 5);
    expect(by.A).toBeGreaterThan(by.F);
    expect(Math.max(...last.rows.map((r) => r.weightPct))).toBeLessThanOrEqual(15.000001);
  });

  it("k=1 单只弱信号不满仓，现金留下", () => {
    const dates = axisDates(320);
    const panels = [rising("A", dates, 80, 0.2), rising("B", dates, 80, 0.15)];
    const all = { start: dates[0], end: null };
    const u = prepareUniverse(panels, new Map(panels.map((p) => [p.ticker, [all]])));
    const a = u.symbols.find((s) => s.ticker === "A")!;
    a.buy1[280] = 1;
    a.rps[280] = 40;
    u.symbols.find((s) => s.ticker === "B")!.rps[280] = 20;

    const result = runBacktest(u, {
      ...DEFAULT_BACKTEST_CONFIG,
      from: dates[260],
      to: dates[319],
      splitDate: "2099-01-01",
      rpsMin: 0,
      useBuy1: true,
      useBuy2: false,
      rpsWeightPower: 1,
    });
    const last = result.holdings[result.holdings.length - 1];
    expect(last).toBeDefined();
    const weightSum = last.rows.reduce((s, r) => s + r.weightPct, 0);
    expect(weightSum).toBeCloseTo(40, 6);
    const lastBook = result.book[result.book.length - 1];
    expect(lastBook.exposurePct).toBeCloseTo(40, 6);
  });

  it("改 Vegas 周期后 runSymbol 当场重算，不沿用准备段的规格缓存", () => {
    const dates = axisDates(40);
    const up = rising("UP", dates, 50, 1);
    const all = { start: dates[0], end: null };
    const u = prepareUniverse([up], new Map([["UP", [all]]]));
    const sym = u.symbols[0];
    expect(sym.vegasOk[39]).toBe(0);

    sym.buy1[35] = 1;
    sym.rps[35] = 50;

    const base = {
      ...DEFAULT_BACKTEST_CONFIG,
      from: dates[0],
      to: dates[39],
      requireVegas: true,
      useBuy1: true,
      useBuy2: false,
      rpsMin: 0,
    };

    const spec = runBacktest(u, base);
    expect(spec.signalCount).toBe(0);

    const short = runBacktest(u, {
      ...base,
      vegasFastA: 3,
      vegasFastB: 4,
      vegasSlowA: 8,
      vegasSlowB: 9,
    });
    expect(short.signalCount).toBe(1);
  });

  /**
   * 清仓根在开盘成交，`prevClose → open` 那一跳属于组合。曾经它被算出来又丢掉，
   * 因为那一根 sigType 已归 0、entryPrice 已置 null，进不了当日持仓表。
   */
  it("清仓根开盘那一跳计入净值：单票满仓时净值等于成交价之比", () => {
    const dates = axisDates(140);
    // 平稳段撑起 ATR14→SMA14 的预热，止损/吊灯才有非零距离
    const n = dates.length;
    const close = new Float32Array(n);
    const open = new Float32Array(n);
    const high = new Float32Array(n);
    const low = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      close[i] = 100;
      open[i] = 100;
      high[i] = 101;
      low[i] = 99;
    }
    // 100 根点火 → 101 根开盘建仓 @100 → 102 根收盘 95 跌破生效止损 96
    // → 103 根开盘 90 平仓（相对前收 95 跳空 -5.26%）
    close[102] = 95;
    low[102] = 94;
    open[103] = 90;
    close[103] = 90;
    low[103] = 89;
    high[103] = 91;

    const all = { start: dates[0], end: null };
    const u = prepareUniverse(
      [{ ticker: "A", dates, high, low, close, volume: null, open }],
      new Map([["A", [all]]]),
    );
    const a = u.symbols[0];
    a.buy1[100] = 1;
    a.rps[100] = 50;

    const r = runBacktest(u, {
      ...DEFAULT_BACKTEST_CONFIG,
      from: dates[100],
      to: dates[103],
      splitDate: "2099-01-01",
      rpsMin: 0,
      useBuy1: true,
      useBuy2: false,
    });

    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.entryPrice).toBeCloseTo(100, 6);
    expect(t.exitPrice).toBeCloseTo(90, 6);
    expect(t.pnlPct).toBeCloseTo(-10, 6);

    // 单票、无单票上限 → 全程满仓，组合净值必须等于 90/100
    expect(r.inSample.portfolio.equity).toBeCloseTo(0.9, 6);
    // 漏掉那一跳会停在 0.95，这里显式钉住，防回归
    expect(r.inSample.portfolio.equity).toBeLessThan(0.94);
  });

  it("buyHold 是真买入持有，与每根拉回等权的 benchmark 不是一回事", () => {
    const dates = axisDates(100);
    const last = dates.length - 1;
    // A 翻倍、B 腰斩：等权买入持有终值 = (2 + 0.5) / 2 = 1.25
    const panels = [
      rising("A", dates, 100, 100 / last),
      rising("B", dates, 100, -50 / last),
    ];
    const all = { start: dates[0], end: null };
    const u = prepareUniverse(panels, new Map(panels.map((p) => [p.ticker, [all]])));

    const r = runBacktest(u, {
      ...DEFAULT_BACKTEST_CONFIG,
      from: dates[0],
      to: dates[last],
      splitDate: "2099-01-01",
      useBuy1: false,
      useBuy2: false,
    });

    expect(r.inSample.buyHold).toBeDefined();
    expect(r.inSample.buyHold!.equity).toBeCloseTo(1.25, 4);
    // 每根再平衡会持续把钱从赢家挪给输家，两条基准必然分岔
    expect(r.inSample.benchmark.equity).not.toBeCloseTo(1.25, 3);
    expect(r.inSample.buyHold!.avgExposurePct).toBe(100);
  });
});
