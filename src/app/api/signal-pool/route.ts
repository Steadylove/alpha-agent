import { NextResponse } from "next/server";

import { CSV_4H_DIR, CSV_PANEL_DIR, hasCsvPanel } from "@/lib/backtest/csvPanel";
import {
  defaultSignalPoolTickers,
  applySignalPool,
  editSignalPool,
  readSignalPool,
  replaceSignalPool,
  tickerListOf,
  writeSignalPool,
  type SignalPoolPatch,
} from "@/lib/fund/signalPool";

export const dynamic = "force-dynamic";

function csvMissing(ticker: string): string[] {
  const missing: string[] = [];
  if (!hasCsvPanel(CSV_PANEL_DIR, ticker)) missing.push("1d");
  if (!hasCsvPanel(CSV_4H_DIR, ticker)) missing.push("4h");
  return missing;
}

function payload(patch: SignalPoolPatch) {
  const base = defaultSignalPoolTickers();
  const members = applySignalPool(base, patch);
  return {
    members,
    memberCount: members.length,
    defaultCount: base.length,
    added: patch.added,
    removed: patch.removed,
    updatedAt: patch.updatedAt || null,
    missingCsv: patch.added.filter((t) => csvMissing(t).length > 0),
  };
}

export async function GET() {
  try {
    return NextResponse.json(payload(await readSignalPool()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "add" && action !== "remove" && action !== "reset" && action !== "replace") {
    return NextResponse.json({ error: "action 必须是 add、remove、reset 或 replace" }, { status: 400 });
  }

  try {
    const next =
      action === "replace"
        ? replaceSignalPool(defaultSignalPoolTickers(), tickerListOf(body.members) ?? [])
        : editSignalPool(
            defaultSignalPoolTickers(),
            await readSignalPool(),
            action,
            typeof body.ticker === "string" ? body.ticker : undefined,
          );
    const saved = await writeSignalPool(next);
    return NextResponse.json({ ok: true, ...payload(saved) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "写入失败";
    const status = message.includes("已在池里") || message.includes("不在池里")
      ? 409
      : message.includes("VPS")
        ? 502
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
