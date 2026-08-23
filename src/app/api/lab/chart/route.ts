import { NextResponse } from "next/server";

import { runSymbol, windowBounds } from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import { parseConfig, parseIndex, tradeRows } from "@/lib/backtest/labRequest";

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

  const config = parseConfig(body);
  const index = parseIndex(body);

  try {
    const universe = await getPreparedUniverse(index);
    const sym = universe.symbols.find((s) => s.ticker === symbol);
    if (!sym) {
      return NextResponse.json({ error: `${symbol} 不在当前标的池内` }, { status: 404 });
    }

    const { lo, hi } = windowBounds(universe.axis, config);
    const { bars, days, closed } = runSymbol(universe.axis, sym, config, lo, hi);

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
    }

    return NextResponse.json({
      symbol,
      splitDate: config.splitDate,
      bars: { time, open, high, low, close },
      levels: { stop, trail, target },
      trades: tradeRows(closed, config.splitDate),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "取图表数据失败" },
      { status: 500 },
    );
  }
}
