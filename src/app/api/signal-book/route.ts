import { NextResponse } from "next/server";

import { lastSettledSession } from "@/lib/backtest/mergeBars";
import { readBookEpoch, resetBookEpoch } from "@/lib/fund/bookEpoch";
import { isLookbackTf } from "@/lib/fund/lookbackLogic";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const tf = new URL(request.url).searchParams.get("tf");
  if (tf != null && !isLookbackTf(tf)) return NextResponse.json({ error: "周期必须是 2h 或 4h" }, { status: 400 });
  try {
    const state = await readBookEpoch();
    const epoch = tf ? state.epochs[tf] : state;
    return NextResponse.json({ tf, from: epoch.from, resetAt: epoch.resetAt || null,
      epochs: state.epochs, defaultFrom: lastSettledSession() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取起点失败" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    const json: unknown = await request.json();
    if (json && typeof json === "object" && !Array.isArray(json)) body = json as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    if (!isLookbackTf(body.tf)) throw new Error("请选择要重新记账的周期：2h 或 4h");
    if (typeof body.from !== "string") throw new Error("请选择记账起点日期");
    const epoch = await resetBookEpoch(body.tf, body.from);
    return NextResponse.json({
      ok: true,
      tf: body.tf,
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
