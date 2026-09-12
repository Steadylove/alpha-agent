/**
 * 信号台：现网定档下，全池每只票在 4H / 2H 最新一根的状态。
 */

import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  runSymbol,
  windowBounds,
  type BacktestConfig,
  type PreparedUniverse,
  type Timeframe,
} from "./engine";
import {
  SMALL_FUND_4H_DEFAULT_CONFIG,
  SMALL_FUND_DEFAULT_CONFIG,
} from "./smallFundUniverse";

export type DeskBarState = {
  symbol: string;
  rps: number;
  close: number;
  lastSignal: 0 | 1 | 2;
  holding: {
    sigType: 1 | 2;
    entryDate: string | null;
    entryPrice: number;
    floatPnlPct: number;
  } | null;
};

export type DeskTfBoard = {
  timeframe: Timeframe;
  asOf: string;
  universeSize: number;
  rows: DeskBarState[];
};

export type DeskBoardRow = {
  symbol: string;
  h4: DeskBarState | null;
  h2: DeskBarState | null;
};

/** 资金计划接口仍用日线冻结档，不要和现网 4H/2H 定档混用。 */
export function frozenDeskConfig(timeframe: Timeframe, to: string): BacktestConfig {
  const frozen = timeframe === "4h" ? SMALL_FUND_4H_DEFAULT_CONFIG : SMALL_FUND_DEFAULT_CONFIG;
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    ...frozen,
    timeframe,
    to,
    splitDate: "2099-01-01",
  };
}

export function scanDeskBoard(universe: PreparedUniverse, config: BacktestConfig): DeskTfBoard {
  const { lo, hi } = windowBounds(universe.axis, config);
  const asOf = hi > lo ? universe.axis[hi - 1]! : "";
  const result = runBacktest(universe, config);
  const lastHold = result.holdings.at(-1);
  const heldOnAsOf = lastHold && lastHold.date === asOf ? lastHold.rows : [];
  const held = new Map(heldOnAsOf.map((r) => [r.symbol, r]));

  const rows: DeskBarState[] = [];
  for (const sym of universe.symbols) {
    const { buy1, buy2, bars } = runSymbol(universe.axis, sym, config, lo, hi);
    const i = bars.findIndex((b) => b.date === asOf);
    if (i < 0) continue;
    const hold = held.get(sym.ticker);
    rows.push({
      symbol: sym.ticker,
      rps: sym.rps[i],
      close: bars[i].close,
      lastSignal: buy1[i] ? 1 : buy2[i] ? 2 : 0,
      holding: hold
        ? {
            sigType: hold.sigType,
            entryDate: hold.entryDate,
            entryPrice: hold.entryPrice,
            floatPnlPct: hold.floatPnlPct,
          }
        : null,
    });
  }
  rows.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return {
    timeframe: config.timeframe,
    asOf,
    universeSize: result.universeSize,
    rows,
  };
}
