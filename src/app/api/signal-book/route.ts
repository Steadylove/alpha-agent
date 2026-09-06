import { NextResponse } from "next/server";

import { lastSettledSession } from "@/lib/backtest/mergeBars";
import { readBookEpoch, resetBookEpoch } from "@/lib/fund/bookEpoch";

export const dynamic = "force-dynamic";

export async function GET() {
  const epoch = readBookEpoch();
  return NextResponse.json({
    from: epoch.from,
    resetAt: epoch.resetAt || null,
    defaultFrom: lastSettledSession(),
  });
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    const epoch = resetBookEpoch(typeof body.from === "string" ? body.from : undefined);
    return NextResponse.json({
      ok: true,
      from: epoch.from,
      resetAt: epoch.resetAt,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "重置失败" },
      { status: 400 },
    );
  }
}
