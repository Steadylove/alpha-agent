/**
 * 信号台：用冻结纪律扫最新一根，列出待执行买点与回测账本里的当前持仓。
 * 人不改公式，只对 pending 确认或否决。
 */

import {
  allocateNameWeights,
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  runSymbol,
  windowBounds,
  type BacktestConfig,
  type PreparedUniverse,
  type Timeframe,
} from "./engine";
import {
  DEFAULT_SMALL_FUND_POOL,
  SMALL_FUND_POOLS,
  type SmallFundPoolId,
} from "./smallFundPools";
import {
  SMALL_FUND_4H_DEFAULT_CONFIG,
  SMALL_FUND_DEFAULT_CONFIG,
} from "./smallFundUniverse";

export type DeskSignal = {
  symbol: string;
  sigType: 1 | 2;
  date: string;
  rps: number;
  close: number;
  rawWeightPct: number;
  weightPct: number;
};

export type DeskHolding = {
  symbol: string;
  sigType: 1 | 2;
  entryDate: string | null;
  entryPrice: number;
  close: number;
  floatPnlPct: number;
  entryRps: number | null;
  rawWeightPct: number;
  weightPct: number;
};

export type DeskSnapshot = {
  timeframe: Timeframe;
  poolId: SmallFundPoolId;
  poolLabel: string;
  asOf: string;
  universeSize: number;
  holdings: DeskHolding[];
  pending: DeskSignal[];
  holdingExposurePct: number;
  pendingExposurePct: number;
  cashPct: number;
};

export function frozenDeskConfig(timeframe: Timeframe, to: string): BacktestConfig {
  const frozen = timeframe === "4h" ? SMALL_FUND_4H_DEFAULT_CONFIG : SMALL_FUND_DEFAULT_CONFIG;
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    ...frozen,
    timeframe: timeframe === "2h" ? "2h" : timeframe,
    to,
    splitDate: "2099-01-01",
  };
}

function rawWeight(rps: number, power: number | null): number {
  if (power == null) return 1;
  return rps >= 1 ? (rps / 100) ** power : 0;
}

export function scanDesk(
  universe: PreparedUniverse,
  config: BacktestConfig,
  poolId: SmallFundPoolId = DEFAULT_SMALL_FUND_POOL,
): DeskSnapshot {
  const { lo, hi } = windowBounds(universe.axis, config);
  const asOf = hi > lo ? universe.axis[hi - 1]! : "";
  const k = config.rpsWeightPower;
  const result = runBacktest(universe, config);
  const lastHold = result.holdings.at(-1);
  const heldOnAsOf = lastHold && lastHold.date === asOf ? lastHold.rows : [];
  const heldSet = new Set(heldOnAsOf.map((r) => r.symbol));

  const holdings: DeskHolding[] = heldOnAsOf.map((row) => {
    const sym = universe.symbols.find((s) => s.ticker === row.symbol);
    const local = sym?.axisIndex.findIndex((d) => universe.axis[d] === asOf) ?? -1;
    const close = local >= 0 && sym ? sym.close[local] : row.entryPrice;
    return {
      symbol: row.symbol,
      sigType: row.sigType,
      entryDate: row.entryDate,
      entryPrice: row.entryPrice,
      close,
      floatPnlPct: row.floatPnlPct,
      entryRps: row.entryRps,
      rawWeightPct: rawWeight(row.entryRps ?? 0, k) * 100,
      weightPct: 0,
    };
  });

  const pending: DeskSignal[] = [];
  for (const sym of universe.symbols) {
    const { buy1, buy2, bars } = runSymbol(universe.axis, sym, config, lo, hi);
    const i = bars.findIndex((b) => b.date === asOf);
    if (i < 0) continue;
    const fired: 1 | 2 | 0 = buy1[i] ? 1 : buy2[i] ? 2 : 0;
    if (fired === 0 || heldSet.has(sym.ticker)) continue;
    pending.push({
      symbol: sym.ticker,
      sigType: fired,
      date: asOf,
      rps: sym.rps[i],
      close: bars[i].close,
      rawWeightPct: rawWeight(sym.rps[i], k) * 100,
      weightPct: 0,
    });
  }
  pending.sort((a, b) => b.rps - a.rps);

  const raws = [
    ...holdings.map((h) => rawWeight(h.entryRps ?? 0, k)),
    ...pending.map((p) => rawWeight(p.rps, k)),
  ];
  const ws = allocateNameWeights(raws, config.maxNameWeight);
  for (const [i, h] of holdings.entries()) h.weightPct = (ws[i] ?? 0) * 100;
  for (const [i, p] of pending.entries()) p.weightPct = (ws[holdings.length + i] ?? 0) * 100;
  const holdingExposurePct = holdings.reduce((s, h) => s + h.weightPct, 0);
  const pendingExposurePct = pending.reduce((s, p) => s + p.weightPct, 0);

  return {
    timeframe: config.timeframe,
    poolId,
    poolLabel: SMALL_FUND_POOLS[poolId].label,
    asOf,
    universeSize: result.universeSize,
    holdings,
    pending,
    holdingExposurePct,
    pendingExposurePct,
    cashPct: Math.max(0, 100 - holdingExposurePct - pendingExposurePct),
  };
}
