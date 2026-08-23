import { NextResponse } from "next/server";

import { runBacktest, type EquityPoint } from "@/lib/backtest/engine";
import { INDEXES, getPreparedUniverse } from "@/lib/backtest/load";
import { parseConfig, parseIndex, tradeRows } from "@/lib/backtest/labRequest";

/**
 * 调参回测接口。
 *
 * 首次请求要载入并预处理全池（十几秒），之后命中进程内缓存，
 * 单次回测约 450 毫秒。
 */

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
