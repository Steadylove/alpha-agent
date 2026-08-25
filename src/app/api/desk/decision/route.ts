import { NextResponse } from "next/server";

import { upsertDecision, type DeskDecisionKind } from "@/lib/backtest/deskLedger";
import { parseSmallFundPoolId } from "@/lib/backtest/smallFundPools";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "";
  const date = typeof body.date === "string" ? body.date : "";
  const timeframe = body.timeframe === "4h" ? "4h" : "1d";
  const poolId = parseSmallFundPoolId(body.poolId);
  const sigType = body.sigType === 2 ? 2 : 1;
  const decision = body.decision === "reject" ? "reject" : body.decision === "confirm" ? "confirm" : null;
  if (!symbol || !date || decision == null) {
    return NextResponse.json({ error: "缺少 symbol / date / decision" }, { status: 400 });
  }

  const row = upsertDecision({
    date,
    timeframe,
    poolId,
    symbol,
    sigType,
    rps: Number(body.rps) || 0,
    rawWeightPct: Number(body.rawWeightPct) || 0,
    decision: decision as DeskDecisionKind,
    note: typeof body.note === "string" ? body.note : "",
  });
  return NextResponse.json(row);
}
