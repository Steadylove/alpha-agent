import { NextResponse } from "next/server";

import {
  DEFAULT_BACKTEST_CONFIG,
  runBacktest,
  type BacktestConfig,
  type EquityPoint,
} from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";

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
  };
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

  try {
    const universe = await getPreparedUniverse();
    const started = Date.now();
    const result = runBacktest(universe, config);

    return NextResponse.json({
      config,
      ...result,
      equity: downsample(result.equity),
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "回测失败" },
      { status: 500 },
    );
  }
}
