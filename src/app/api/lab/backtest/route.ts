import { NextResponse } from "next/server";

import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  type BacktestConfig,
  type EquityPoint,
} from "@/lib/backtest/engine";
import { DEFAULT_INDEX, INDEXES, getPreparedUniverse, type IndexKey } from "@/lib/backtest/load";
import type { ClosedTrade } from "@/lib/scoring/rotationTrade";

/**
 * 调参回测接口。
 *
 * 首次请求要载入并预处理全池（十几秒），之后命中进程内缓存，
 * 单次回测约 250 毫秒。
 */

const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

function parseConfig(body: Record<string, unknown>): BacktestConfig {
  const d = DEFAULT_BACKTEST_CONFIG;
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
    useBuy1: typeof body.useBuy1 === "boolean" ? body.useBuy1 : d.useBuy1,
    useBuy2: typeof body.useBuy2 === "boolean" ? body.useBuy2 : d.useBuy2,
    minAdtvUsd: clamp(body.minAdtvUsd, 0, 5e9, d.minAdtvUsd),
    minPrice: clamp(body.minPrice, 0, 200, d.minPrice),
    requireTrend:
      typeof body.requireTrend === "boolean" ? body.requireTrend : d.requireTrend,
  };
}

/**
 * 明细行。丢掉 entryIndex/exitIndex（那是每个标的自己的下标，前端无从解读），
 * 补上 R 倍数与所属窗口，省得前端各算一遍。
 */
function tradeRows(trades: readonly ClosedTrade[], splitDate: string) {
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

/**
 * 标的池不进 BacktestConfig：它决定载入哪批数据（缓存键），
 * 而 config 里的参数都是在同一批数据上重算的，两者生命周期不同。
 */
function parseIndex(body: Record<string, unknown>): IndexKey {
  const raw = typeof body.index === "string" ? body.index.toUpperCase() : "";
  return raw in INDEXES ? (raw as IndexKey) : DEFAULT_INDEX;
}

/** 净值曲线抽稀到约 700 点：日线全传是四千多点，画到屏幕上分辨不出差别。 */
function downsample(points: readonly EquityPoint[], target = 700): EquityPoint[] {
  if (points.length <= target) return [...points];
  const step = points.length / target;
  const out: EquityPoint[] = [];
  for (let i = 0; i < target; i += 1) out.push(points[Math.floor(i * step)]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // 空 body 走全默认参数
  }

  const config = parseConfig(body);
  const index = parseIndex(body);

  try {
    const universe = await getPreparedUniverse(index);
    const started = Date.now();
    const result = runBacktest(universe, config);

    return NextResponse.json({
      config,
      index,
      indexLabel: INDEXES[index].label,
      symbolCount: universe.symbols.length,
      ...result,
      equity: downsample(result.equity),
      trades: tradeRows(result.trades, config.splitDate),
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "回测失败" },
      { status: 500 },
    );
  }
}
