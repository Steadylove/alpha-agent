import { NextResponse } from "next/server";

import { normalizeBookFrom } from "@/lib/fund/bookEpochLogic";
import { runLookback } from "@/lib/fund/lookback";
import { isLookbackTf } from "@/lib/fund/lookbackLogic";
import { tickerListOf } from "@/lib/fund/signalPoolLogic";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(tfRaw: unknown, fromRaw: unknown, membersRaw: unknown) {
  const tf = typeof tfRaw === "string" ? tfRaw : null;
  const from = normalizeBookFrom(typeof fromRaw === "string" ? fromRaw : null);
  if (!isLookbackTf(tf) || !from) {
    return NextResponse.json({ error: "tf 必须是 4h 或 2h，from 必须是 YYYY-MM-DD" }, { status: 400 });
  }
  const members = tickerListOf(membersRaw);
  if (members && members.length === 0) {
    return NextResponse.json({ error: "信号池是空的" }, { status: 400 });
  }

  try {
    const view = await runLookback(tf, from, members);
    return NextResponse.json({ ok: true, tf, ...view });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "回看失败" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return handle(url.searchParams.get("tf"), url.searchParams.get("from"), null);
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }
  return handle(body.tf, body.from, body.members);
}
