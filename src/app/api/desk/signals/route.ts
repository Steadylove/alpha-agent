import { NextResponse } from "next/server";

import { decisionMap, deskDecisionId, readLedger } from "@/lib/backtest/deskLedger";
import { frozenDeskConfig, scanDesk } from "@/lib/backtest/deskScan";
import { DEFAULT_SMALL_FUND_POOL, parseSmallFundPoolId } from "@/lib/backtest/smallFundPools";
import { getPreparedUniverse } from "@/lib/backtest/load";
import type { Timeframe } from "@/lib/backtest/engine";

export const dynamic = "force-dynamic";

function parseTf(raw: string | null): Timeframe {
  return raw === "4h" ? "4h" : "1d";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const timeframe = parseTf(url.searchParams.get("timeframe"));
  const poolId = parseSmallFundPoolId(url.searchParams.get("poolId") ?? DEFAULT_SMALL_FUND_POOL);

  try {
    const universe = await getPreparedUniverse("SMALLFUND", timeframe, poolId);
    const to = universe.axis.at(-1) ?? "2099-01-01";
    const started = Date.now();
    const snapshot = scanDesk(universe, frozenDeskConfig(timeframe, to), poolId);
    const ledger = readLedger();
    const byId = decisionMap(ledger);
    const pending = snapshot.pending.map((row) => ({
      ...row,
      decision: byId.get(deskDecisionId({ ...row, timeframe, poolId })) ?? null,
    }));
    return NextResponse.json({
      ...snapshot,
      pending,
      ledger: ledger.filter((d) => d.timeframe === timeframe && d.poolId === poolId).slice(0, 40),
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "扫描失败" },
      { status: 500 },
    );
  }
}
