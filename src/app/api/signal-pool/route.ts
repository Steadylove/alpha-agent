import { NextResponse } from "next/server";

import { CSV_4H_DIR, CSV_PANEL_DIR, hasCsvPanel } from "@/lib/backtest/csvPanel";
import { smallFundSource } from "@/lib/backtest/load";
import {
  defaultSignalPoolTickers,
  editSignalPool,
  readSignalPool,
  readSignalPoolMembers,
  writeSignalPool,
} from "@/lib/fund/signalPool";

export const dynamic = "force-dynamic";

function csvMissing(ticker: string): string[] {
  if (smallFundSource() === "db") return [];
  const missing: string[] = [];
  if (!hasCsvPanel(CSV_PANEL_DIR, ticker)) missing.push("1d");
  if (!hasCsvPanel(CSV_4H_DIR, ticker)) missing.push("4h");
  return missing;
}

function payload() {
  const base = defaultSignalPoolTickers();
  const patch = readSignalPool();
  const members = readSignalPoolMembers(base);
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
  return NextResponse.json(payload());
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }

  const action = body.action;
  if (action !== "add" && action !== "remove" && action !== "reset") {
    return NextResponse.json({ error: "action 必须是 add、remove 或 reset" }, { status: 400 });
  }

  try {
    const next = editSignalPool(
      defaultSignalPoolTickers(),
      readSignalPool(),
      action,
      typeof body.ticker === "string" ? body.ticker : undefined,
    );
    writeSignalPool(next);
    return NextResponse.json({ ok: true, ...payload() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "写入失败";
    const status = message.includes("已在池里") || message.includes("不在池里") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
