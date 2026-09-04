import { NextResponse } from "next/server";

import {
  runSymbol,
  vegasLensOf,
  windowBounds,
  type BacktestConfig,
  type PreparedSymbol,
} from "@/lib/backtest/engine";
import type { TradeDay } from "@/lib/scoring/rotationTrade";
import { getPreparedUniverse } from "@/lib/backtest/load";
import { parseConfig, parseIndex, parsePoolId, tradeRows } from "@/lib/backtest/labRequest";
import { champOf } from "@/lib/fund/champs";
import { runChampSymbol } from "@/lib/fund/frozenLab";
import { emaSeries } from "@/lib/scoring/series";

/**
 * 单只标的的 K 线与该次回测在它身上的进出场点、止损线、吊灯线。
 *
 * 和 /api/lab/backtest 共用 `parseConfig` 与 `runSymbol`，所以图上画的每个点
 * 都来自与逐笔表同一份计算——不是另算一遍近似值。
 *
 * 数据全部取自本地面板快照，不访问数据库。
 */

/** 止损/吊灯只在持仓期存在，空仓日填 null，前端据此断线。 */
type Level = number | null;

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // 空 body 走全默认参数
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "";
  if (!symbol) {
    return NextResponse.json({ error: "缺少 symbol" }, { status: 400 });
  }

  const champ = typeof body.champ === "string" ? champOf(body.champ) : null;
  const config = champ?.config ?? parseConfig(body);
  const index = champ ? "SMALLFUND" : parseIndex(body);
  const poolId = champ?.poolId ?? parsePoolId(body);

  try {
    const universe = await getPreparedUniverse(index, config.timeframe, poolId);
    const ran = champ
      ? runChampSymbol(universe, champ, symbol)
      : null;
    const sym = ran?.sym ?? universe.symbols.find((s) => s.ticker === symbol);
    if (!sym || (champ && !ran)) {
      return NextResponse.json({ error: `${symbol} 不在当前标的池内` }, { status: 404 });
    }

    const { lo, hi } = ran
      ? { lo: ran.lo, hi: ran.hi }
      : windowBounds(universe.axis, config);
    const { bars, days, closed } = ran ?? runSymbol(universe.axis, sym, config, lo, hi);

    const closes = Array.from(sym.close);
    const lens = vegasLensOf(config);
    const emaFastA = emaSeries(closes, lens.fast[0]);
    const emaFastB = emaSeries(closes, lens.fast[1]);
    const emaSlowA = emaSeries(closes, lens.slow[0]);
    const emaSlowB = emaSeries(closes, lens.slow[1]);

    // 回该标的在面板里的全部历史，不裁到回测窗口：预热期没有信号（掩码已挡住入场），
    // 风控线在那段天然为 null，多给出来只是让图上能看到更早的形态。
    const time: string[] = [];
    const open: number[] = [];
    const high: number[] = [];
    const low: number[] = [];
    const close: number[] = [];
    const stop: Level[] = [];
    const trail: Level[] = [];
    const target: Level[] = [];
    const rsi: Level[] = [];
    const vegas = {
      fastA: [] as Level[],
      fastB: [] as Level[],
      slowA: [] as Level[],
      slowB: [] as Level[],
    };

    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i];
      time.push(bar.date);
      open.push(bar.open ?? bar.close);
      high.push(bar.high);
      low.push(bar.low);
      close.push(bar.close);
      const day = days[i];
      stop.push(day?.stopLevel ?? null);
      trail.push(day?.trailLevel ?? null);
      target.push(day?.targetLevel ?? null);
      rsi.push(sym.rsi14[i] > 0 ? sym.rsi14[i] : null);
      vegas.fastA.push(emaFastA[i]);
      vegas.fastB.push(emaFastB[i]);
      vegas.slowA.push(emaSlowA[i]);
      vegas.slowB.push(emaSlowB[i]);
    }

    const signals = collectSignals(sym, config, lo, hi, days, time, {
      dayCloseOnly: champ?.opts.entryWindow === "dayClose",
    });

    return NextResponse.json({
      symbol,
      splitDate: config.splitDate,
      filters: {
        requireRsi: config.requireRsi,
        minRsi: config.minRsi,
        requireVegas: config.requireVegas,
        vegas: {
          fastA: config.vegasFastA,
          fastB: config.vegasFastB,
          slowA: config.vegasSlowA,
          slowB: config.vegasSlowB,
        },
      },
      bars: { time, open, high, low, close },
      levels: { stop, trail, target },
      vegas,
      rsi,
      signals,
      trades: tradeRows(closed, config.splitDate),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "取图表数据失败" },
      { status: 500 },
    );
  }
}

/**
 * 原始一买/二买（MACD 点火）逐条定性：过了哪些闸门、卡在哪、次日有没有成交。
 * 图上靠这个区分「开仓 / 过滤」，而不是只画已经成交的箭头。
 */
function collectSignals(
  sym: PreparedSymbol,
  config: BacktestConfig,
  lo: number,
  hi: number,
  days: TradeDay[],
  time: string[],
  opts?: { dayCloseOnly?: boolean },
) {
  const lens = vegasLensOf(config);
  const closes = Array.from(sym.close);
  const a = emaSeries(closes, lens.fast[0]);
  const b = emaSeries(closes, lens.fast[1]);
  const c = emaSeries(closes, lens.slow[0]);
  const d = emaSeries(closes, lens.slow[1]);

  const out: {
    date: string;
    sigType: 1 | 2;
    rsi: number | null;
    rps: number;
    vegasOk: boolean;
    accepted: boolean;
    reject: string | null;
    fillDate: string | null;
  }[] = [];

  for (let i = 0; i < time.length; i += 1) {
    const raw1 = config.useBuy1 && sym.buy1[i] === 1;
    const raw2 = config.useBuy2 && sym.buy2[i] === 1;
    if (!raw1 && !raw2) continue;

    const sigType: 1 | 2 = raw1 ? 1 : 2;
    const rsi = sym.rsi14[i] > 0 ? sym.rsi14[i] : null;
    const rps = sym.rps[i];
    const fa = a[i];
    const fb = b[i];
    const sa = c[i];
    const sb = d[i];
    const vegasReady = fa != null && fb != null && sa != null && sb != null;
    const vegasOk = vegasReady && Math.min(fa, fb) > Math.max(sa, sb);

    const dAxis = sym.axisIndex[i];
    let reject: string | null = null;
    if (dAxis < lo || dAxis >= hi) reject = "窗口外";
    else if (sym.isMember[i] === 0) reject = "非成分";
    else if (rps < 1) reject = "RPS未齐";
    else if (rps < config.rpsMin) reject = `RPS ${rps.toFixed(0)}`;
    else if (config.minAdtvUsd > 0 && sym.adtv50[i] < config.minAdtvUsd) reject = "成交额";
    else if (config.minPrice > 0 && sym.close[i] < config.minPrice) reject = "价格";
    else if (config.requireTrend && sym.aboveTrend[i] === 0) reject = "趋势";
    else if (config.requireRsi && (rsi == null || rsi < config.minRsi)) {
      reject = rsi == null ? "RSI未齐" : `RSI ${rsi.toFixed(0)}`;
    }     else if (config.requireVegas && !vegasOk) reject = vegasReady ? "Vegas" : "Vegas未齐";
    else if (days[i]?.sigType !== 0) reject = "持仓中";
    else if (
      opts?.dayCloseOnly &&
      i + 1 < time.length &&
      time[i + 1].slice(0, 10) === time[i].slice(0, 10)
    ) {
      reject = "非收盘根";
    }

    const fillDate = time[i + 1] ?? null;
    const filled = reject == null && days[i + 1]?.entered === true;
    if (reject == null && !filled) reject = "未成交";

    out.push({
      date: time[i],
      sigType,
      rsi,
      rps,
      vegasOk,
      accepted: filled,
      reject: filled ? null : reject,
      fillDate: filled ? fillDate : null,
    });
  }

  return out;
}
