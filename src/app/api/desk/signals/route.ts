import { NextResponse } from "next/server";

import { scanDeskBoard, type DeskBarState, type DeskBoardRow, type DeskTfBoard } from "@/lib/backtest/deskScan";
import { getPreparedUniverse } from "@/lib/backtest/load";
import { champOf } from "@/lib/fund/champs";
import { clipUniverseToSignalPool, readSignalPoolMembers } from "@/lib/fund/signalPool";

export const dynamic = "force-dynamic";

async function scanChamp(id: "4h" | "2h-broad", members: readonly string[]): Promise<DeskTfBoard> {
  const champ = champOf(id);
  const full = await getPreparedUniverse("SMALLFUND", champ.config.timeframe, champ.poolId, members);
  const uni = await clipUniverseToSignalPool(full, members);
  const to = uni.axis.at(-1) ?? champ.config.to;
  return scanDeskBoard(uni, { ...champ.config, to, splitDate: "2099-01-01" });
}

function mergeRows(h4: DeskTfBoard, h2: DeskTfBoard): DeskBoardRow[] {
  const symbols = [...new Set([...h4.rows.map((r) => r.symbol), ...h2.rows.map((r) => r.symbol)])];
  const a = new Map(h4.rows.map((r) => [r.symbol, r]));
  const b = new Map(h2.rows.map((r) => [r.symbol, r]));
  const live = (s: DeskBarState | null) => Boolean(s && (s.lastSignal || s.holding));
  return symbols
    .map((symbol) => ({ symbol, h4: a.get(symbol) ?? null, h2: b.get(symbol) ?? null }))
    .sort((x, y) => {
      const rx = (live(x.h4) ? 2 : 0) + (live(x.h2) ? 1 : 0);
      const ry = (live(y.h4) ? 2 : 0) + (live(y.h2) ? 1 : 0);
      return ry - rx || x.symbol.localeCompare(y.symbol);
    });
}

export async function GET() {
  const started = Date.now();
  try {
    const members = await readSignalPoolMembers();
    const [h4, h2] = await Promise.all([scanChamp("4h", members), scanChamp("2h-broad", members)]);
    return NextResponse.json({
      poolSize: members.length,
      h4: { asOf: h4.asOf, universeSize: h4.universeSize },
      h2: { asOf: h2.asOf, universeSize: h2.universeSize },
      rows: mergeRows(h4, h2),
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "扫描失败" },
      { status: 500 },
    );
  }
}
