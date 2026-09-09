import { NextResponse } from "next/server";

import { CSV_4H_DIR, CSV_PANEL_DIR, hasCsvPanel } from "@/lib/backtest/csvPanel";
import { invalidateSmallFundCache } from "@/lib/backtest/load";
import { appendLiveBookChange, readLiveBook } from "@/lib/backtest/liveBook";
import { membersOn } from "@/lib/backtest/smallFundPools";

export const dynamic = "force-dynamic";

function csvMissing(ticker: string): string[] {
  const missing: string[] = [];
  if (!hasCsvPanel(CSV_PANEL_DIR, ticker)) missing.push("1d");
  if (!hasCsvPanel(CSV_4H_DIR, ticker)) missing.push("4h");
  return missing;
}

export async function GET(request: Request) {
  const asOf = new URL(request.url).searchParams.get("asOf") ?? new Date().toISOString().slice(0, 10);
  const changes = readLiveBook();
  const members = membersOn("sf-live", asOf, changes);
  const missing = members.filter((t) => csvMissing(t).length === 2);
  return NextResponse.json({
    asOf: asOf.slice(0, 10),
    members,
    memberCount: members.length,
    missingCsv: missing,
    changes: changes.slice().reverse(),
  });
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }

  const action = body.action === "remove" ? "remove" : body.action === "add" ? "add" : null;
  const ticker = typeof body.ticker === "string" ? body.ticker : "";
  const date = typeof body.date === "string" ? body.date : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (action == null) {
    return NextResponse.json({ error: "action 必须是 add 或 remove" }, { status: 400 });
  }

  try {
    const day = date.slice(0, 10);
    const changes = readLiveBook();
    const now = membersOn("sf-live", day, changes);
    const sym = ticker.trim().toUpperCase();
    if (action === "add" && now.includes(sym)) {
      return NextResponse.json({ error: `${sym} 在 ${day} 已经在活账本里` }, { status: 409 });
    }
    if (action === "remove" && !now.includes(sym)) {
      return NextResponse.json({ error: `${sym} 在 ${day} 不在活账本里` }, { status: 409 });
    }

    const change = appendLiveBookChange({ ticker: sym, action, date: day, reason });
    invalidateSmallFundCache();
    return NextResponse.json({
      change,
      missingCsv: csvMissing(change.ticker),
      memberCount: membersOn("sf-live", day, readLiveBook()).length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "写入失败" },
      { status: 400 },
    );
  }
}
