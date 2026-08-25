/**
 * `/lab` 两个接口（回测、单只标的图表）共用的请求解析与逐笔行格式化。
 *
 * 抽出来是因为图表必须和回测跑在**同一组配置**上：参数解析各写一遍的话，
 * 某个钳位边界改了一边没改另一边，图上就会画出与逐笔表不同的进出场点。
 */

import {
  DEFAULT_BACKTEST_CONFIG,
  type BacktestConfig,
  type Timeframe,
} from "@/lib/backtest/engine";
import { DEFAULT_INDEX, INDEXES, type IndexKey } from "@/lib/backtest/load";
import {
  DEFAULT_SMALL_FUND_POOL,
  parseSmallFundPoolId,
  type SmallFundPoolId,
} from "@/lib/backtest/smallFundPools";
import {
  SMALL_FUND_4H_DEFAULT_CONFIG,
  SMALL_FUND_DEFAULT_CONFIG,
} from "@/lib/backtest/smallFundUniverse";
import type { ClosedTrade } from "@/lib/scoring/rotationTrade";

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function parseTimeframe(body: Record<string, unknown>): Timeframe {
  return body.timeframe === "4h" ? "4h" : "1d";
}

export function parseConfig(body: Record<string, unknown>): BacktestConfig {
  const index = parseIndex(body);
  const timeframe = parseTimeframe(body);
  if (timeframe === "4h" && index !== "SMALLFUND") {
    throw new Error("4H 回测目前只支持 Small Fund 池（Alpaca 1H 合成）");
  }
  // Small Fund 没传的旋钮落在日线/4H 当前纪律上；传了就按请求改。
  const d: BacktestConfig =
    index === "SMALLFUND"
      ? {
          ...DEFAULT_BACKTEST_CONFIG,
          ...(timeframe === "4h" ? SMALL_FUND_4H_DEFAULT_CONFIG : SMALL_FUND_DEFAULT_CONFIG),
          timeframe,
        }
      : { ...DEFAULT_BACKTEST_CONFIG, timeframe };
  return {
    from: typeof body.from === "string" ? body.from : d.from,
    to: typeof body.to === "string" ? body.to : d.to,
    splitDate: typeof body.splitDate === "string" ? body.splitDate : d.splitDate,
    rpsMin: clamp(body.rpsMin, 0, 99, d.rpsMin),
    stopMult: clamp(body.stopMult, 0.5, 12, d.stopMult),
    trailMult: clamp(body.trailMult, 0.5, 20, d.trailMult),
    // 这三项要区分"没传"和"显式传了关闭值"：没传取默认，显式 null/false 就是关掉
    rpsExit: !("rpsExit" in body)
      ? d.rpsExit
      : body.rpsExit == null
        ? null
        : clamp(body.rpsExit, 1, 95, 30),
    takeProfitR: !("takeProfitR" in body)
      ? d.takeProfitR
      : body.takeProfitR == null
        ? null
        : clamp(body.takeProfitR, 0.25, 20, 2),
    riskBudgetPct: !("riskBudgetPct" in body)
      ? d.riskBudgetPct
      : body.riskBudgetPct == null
        ? null
        : clamp(body.riskBudgetPct, 0.1, 20, 0.8),
    useBuy1: typeof body.useBuy1 === "boolean" ? body.useBuy1 : d.useBuy1,
    useBuy2: typeof body.useBuy2 === "boolean" ? body.useBuy2 : d.useBuy2,
    minAdtvUsd: clamp(body.minAdtvUsd, 0, 5e9, d.minAdtvUsd),
    minPrice: clamp(body.minPrice, 0, 200, d.minPrice),
    requireTrend:
      typeof body.requireTrend === "boolean" ? body.requireTrend : d.requireTrend,
    requireRsi: typeof body.requireRsi === "boolean" ? body.requireRsi : d.requireRsi,
    minRsi: clamp(body.minRsi, 1, 100, d.minRsi),
    requireVegas:
      typeof body.requireVegas === "boolean" ? body.requireVegas : d.requireVegas,
    vegasFastA: clamp(body.vegasFastA, 5, 900, d.vegasFastA),
    vegasFastB: clamp(body.vegasFastB, 5, 900, d.vegasFastB),
    vegasSlowA: clamp(body.vegasSlowA, 5, 900, d.vegasSlowA),
    vegasSlowB: clamp(body.vegasSlowB, 5, 900, d.vegasSlowB),
    rpsWeightPower: !("rpsWeightPower" in body)
      ? d.rpsWeightPower
      : body.rpsWeightPower == null
        ? null
        : clamp(body.rpsWeightPower, 0, 5, 1),
    maxHoldings: !("maxHoldings" in body)
      ? d.maxHoldings
      : body.maxHoldings == null
        ? null
        : clamp(body.maxHoldings, 1, 50, 8),
    timeframe,
  };
}

/**
 * 标的池不进 BacktestConfig：它决定载入哪批数据（缓存键），
 * 而 config 里的参数都是在同一批数据上重算的，两者生命周期不同。
 */
export function parseIndex(body: Record<string, unknown>): IndexKey {
  const raw = typeof body.index === "string" ? body.index.toUpperCase() : "";
  return raw in INDEXES ? (raw as IndexKey) : DEFAULT_INDEX;
}

export function parsePoolId(body: Record<string, unknown>): SmallFundPoolId {
  return parseIndex(body) === "SMALLFUND"
    ? parseSmallFundPoolId(body.poolId)
    : DEFAULT_SMALL_FUND_POOL;
}

/**
 * 明细行。丢掉 entryIndex/exitIndex（那是每个标的自己的下标，前端无从解读），
 * 补上 R 倍数与所属窗口，省得前端各算一遍。
 */
export function tradeRows(trades: readonly ClosedTrade[], splitDate: string) {
  return trades.map((t) => ({
    symbol: t.symbol,
    sigType: t.sigType,
    entryDate: t.entryDate,
    entryPrice: t.entryPrice,
    exitDate: t.exitDate,
    exitPrice: t.exitPrice,
    pnlPct: t.pnlPct,
    barsHeld: t.barsHeld,
    exitReason: t.exitReason,
    riskPct: t.riskPct,
    r: t.riskPct > 0 ? t.pnlPct / t.riskPct : 0,
    isOutOfSample: t.entryDate >= splitDate,
  }));
}
