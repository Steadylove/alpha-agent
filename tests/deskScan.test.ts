import { describe, expect, it } from "vitest";

import {
  DEFAULT_BACKTEST_CONFIG,
  prepareUniverse,
} from "@/lib/backtest/engine";
import { scanDeskBoard } from "@/lib/backtest/deskScan";
import type { PanelBars } from "@/lib/backtest/panel";

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

describe("deskScan", () => {
  it("列出全池：本根点火记 lastSignal，未持仓则为空仓", () => {
    const dates = axisDates(320);
    const panels = [rising("A", dates, 80, 0.2), rising("B", dates, 80, 0.15)];
    const all = { start: dates[0], end: null };
    const u = prepareUniverse(panels, new Map(panels.map((p) => [p.ticker, [all]])));
    const last = dates.length - 1;
    const a = u.symbols.find((s) => s.ticker === "A")!;
    a.buy1[last] = 1;
    a.rps[last] = 40;
    u.symbols.find((s) => s.ticker === "B")!.rps[last] = 20;

    const snap = scanDeskBoard(u, {
      ...DEFAULT_BACKTEST_CONFIG,
      from: dates[260],
      to: dates[last],
      splitDate: "2099-01-01",
      rpsMin: 0,
      useBuy1: true,
      useBuy2: false,
      requireRsi: false,
      requireVegas: false,
      rpsWeightPower: 1,
    });

    expect(snap.asOf).toBe(dates[last]);
    expect(snap.rows).toHaveLength(2);
    expect(snap.rows.find((r) => r.symbol === "A")).toMatchObject({
      lastSignal: 1,
      holding: null,
      rps: 40,
    });
    expect(snap.rows.find((r) => r.symbol === "B")).toMatchObject({ lastSignal: 0, holding: null });
  });
});
