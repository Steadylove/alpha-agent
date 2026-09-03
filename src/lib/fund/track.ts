import {
  runSymbol,
  windowBounds,
  type BacktestConfig,
  type PreparedSymbol,
  type PreparedUniverse,
} from "@/lib/backtest/engine";
import {
  advancePositionRisk,
  effectiveStopOf,
  openPositionRisk,
  riskAtrSeries,
  type TradeBar,
} from "@/lib/scoring/rotationTrade";

import type { FundLot } from "./bookLogic";
import type { PlanPosition, PlanSignal } from "./plan";

/**
 * 把账本里的真实持仓接到行情上：推出每只当前的吊灯位，判断今天是否该走。
 *
 * 吊灯是路径依赖的（只上移，浮盈过档收紧，保本锁），所以必须从**实际成交价**那根
 * 逐根推到今天，不能拿今天的价格反推。用实际成交价而非回测的开盘价，是这套东西
 * 和 `scanDesk` 的根本区别——后者推演的是「从头严格照做会持有什么」。
 */

function barsOf(sym: PreparedSymbol, axis: string[]): TradeBar[] {
  const n = sym.axisIndex.length;
  const bars: TradeBar[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    bars[i] = {
      date: axis[sym.axisIndex[i]],
      high: sym.high[i],
      low: sym.low[i],
      close: sym.close[i],
      open: sym.open?.[i],
    };
  }
  return bars;
}

export type TrackResult = {
  positions: PlanPosition[];
  /** 账本里有、但行情里找不到（或日期对不上）的持仓，必须让人看见 */
  unresolved: { symbol: string; why: string }[];
};

export function trackPositions(
  universe: PreparedUniverse,
  config: BacktestConfig,
  lots: readonly FundLot[],
  asOf: string,
): TrackResult {
  const positions: PlanPosition[] = [];
  const unresolved: { symbol: string; why: string }[] = [];

  for (const lot of lots) {
    const sym = universe.symbols.find((s) => s.ticker === lot.symbol);
    if (!sym) {
      unresolved.push({ symbol: lot.symbol, why: "行情面板里没有这只票" });
      continue;
    }

    const bars = barsOf(sym, universe.axis);
    const atr = riskAtrSeries(bars);
    const ei = bars.findIndex((b) => b.date.slice(0, 10) >= lot.entryDate);
    let ai = -1;
    for (let i = 0; i < bars.length; i += 1) {
      if (bars[i].date.slice(0, 10) <= asOf) ai = i;
      else break;
    }

    if (ei < 0 || ai < ei) {
      unresolved.push({ symbol: lot.symbol, why: `行情里没有 ${lot.entryDate} 之后的数据` });
      continue;
    }
    // 状态机开仓用的是点火那根的 ATR（挂单在前一根收盘），这里对齐它
    const entryAtr = atr[Math.max(0, ei - 1)];
    if (entryAtr == null || entryAtr <= 0) {
      unresolved.push({ symbol: lot.symbol, why: `${lot.entryDate} 的 ATR 不可用` });
      continue;
    }

    let risk = openPositionRisk(lot.entryPrice, entryAtr, config.stopMult, config.trailMult);
    for (let i = ei; i <= ai; i += 1) {
      const a = atr[i];
      if (a == null || a <= 0) continue;
      risk = advancePositionRisk(risk, bars[i], a, lot.entryPrice, config.trailMult);
    }

    const stop = effectiveStopOf(risk);
    positions.push({
      lot,
      close: bars[ai].close,
      rps: sym.rps[ai],
      effectiveStop: stop,
      stopHit: bars[ai].close < stop,
    });
  }

  return { positions, unresolved };
}

/**
 * 扫最后一根的新信号。
 *
 * 与 `scanDesk` 不同，这里不剔除任何持仓——「已持仓所以不买」由 `planDay` 依据
 * **真实账本**判断，不是依据回测推演的持仓。
 */
export function scanSignals(
  universe: PreparedUniverse,
  config: BacktestConfig,
  asOf: string,
): PlanSignal[] {
  const { lo, hi } = windowBounds(universe.axis, config);
  const out: PlanSignal[] = [];
  for (const sym of universe.symbols) {
    const { buy1, buy2, bars } = runSymbol(universe.axis, sym, config, lo, hi);
    const i = bars.findIndex((b) => b.date === asOf);
    if (i < 0) continue;
    const fired: 1 | 2 | 0 = buy1[i] ? 1 : buy2[i] ? 2 : 0;
    if (fired === 0) continue;
    out.push({ symbol: sym.ticker, sigType: fired, rps: sym.rps[i], close: bars[i].close });
  }
  return out.sort((a, b) => b.rps - a.rps);
}
