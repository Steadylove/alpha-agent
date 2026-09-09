import { NextResponse } from "next/server";

import { normalizeBookFrom } from "@/lib/fund/bookEpochLogic";
import { runLookback } from "@/lib/fund/lookback";
import { clampLookbackSlots, DEFAULT_LOOKBACK_SLOTS, isLookbackTf } from "@/lib/fund/lookbackLogic";
import { pickLookbackPool } from "@/lib/fund/lookbackPick";
import { clampPickSize, isLookbackPickTf } from "@/lib/fund/lookbackPickLogic";
import { tickerListOf } from "@/lib/fund/signalPoolLogic";
import { TWO_HOUR_VERSION } from "@/lib/backtest/twoHourVersion";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handlePick(body: Record<string, unknown>) {
  const from = normalizeBookFrom(body.from);
  const to = body.to == null || body.to === "" ? undefined : normalizeBookFrom(body.to);
  const n = clampPickSize(body.n);
  if (!from || !isLookbackPickTf(body.tf) || n == null || to === null) {
    return NextResponse.json(
      { error: "from 必须是 YYYY-MM-DD，n 必须是 1–120，tf 必须是 4h、2h 或 both" },
      { status: 400 },
    );
  }
  if (to && to < from) {
    return NextResponse.json({ error: "终点必须晚于起点" }, { status: 400 });
  }
  try {
    const picked = await pickLookbackPool(from, n, body.tf, to);
    return NextResponse.json({ ok: true, from, to: to ?? null, tf: body.tf, n, ...picked });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "查找失败" },
      { status: 500 },
    );
  }
}

async function handle(tfRaw: unknown, fromRaw: unknown, membersRaw: unknown, slotsRaw: unknown) {
  const tf = typeof tfRaw === "string" ? tfRaw : null;
  const from = normalizeBookFrom(typeof fromRaw === "string" ? fromRaw : null);
  const slots = slotsRaw == null || slotsRaw === "" ? DEFAULT_LOOKBACK_SLOTS : clampLookbackSlots(slotsRaw);
  if (!isLookbackTf(tf) || !from || slots == null) {
    return NextResponse.json(
      { error: "tf 必须是 4h 或 2h，from 必须是 YYYY-MM-DD，每笔投入比例的分母必须是 1–20" },
      { status: 400 },
    );
  }
  const members = tickerListOf(membersRaw);
  if (members && members.length === 0) {
    return NextResponse.json({ error: "信号池是空的" }, { status: 400 });
  }

  try {
    const view = await runLookback(tf, from, members, slots);
    return NextResponse.json({ ok: true, tf, slots, twoHourVersion: tf === "2h" ? TWO_HOUR_VERSION : undefined, ...view });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "回看失败" },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  return handle(
    url.searchParams.get("tf"),
    url.searchParams.get("from"),
    null,
    url.searchParams.get("slots"),
  );
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }
  if (body.action === "pick") return handlePick(body);
  return handle(body.tf, body.from, body.members, body.slots);
}
