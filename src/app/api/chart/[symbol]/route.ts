import { NextResponse } from "next/server";
import {
  getStockChartDataWithFallback,
  type ChartInterval,
} from "@/lib/dashboard/stockChart";
import type { Playbook } from "@/lib/scoring/rpsPlaybooks";

const INTERVALS = new Set<ChartInterval>(["1d", "4h", "1h"]);
const PLAYBOOKS = new Set<Playbook>([
  "PULLBACK",
  "CLIMAX_FILTER",
  "EARLY_ACCELERATION",
]);

export async function GET(
  request: Request,
  context: { params: Promise<{ symbol: string }> },
) {
  const { symbol } = await context.params;
  const upper = symbol.toUpperCase();
  if (!/^[A-Z.]{1,8}$/.test(upper) && !/^[A-Z]+-[A-Z]$/.test(upper)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const url = new URL(request.url);
  const intervalRaw = (url.searchParams.get("interval") ?? "1d") as ChartInterval;
  const playbookRaw = url.searchParams.get("playbook") as Playbook | null;
  const interval = INTERVALS.has(intervalRaw) ? intervalRaw : "1d";
  const playbook =
    playbookRaw && PLAYBOOKS.has(playbookRaw) ? playbookRaw : null;

  try {
    const data = await getStockChartDataWithFallback(upper, { interval, playbook });
    if (!data) {
      return NextResponse.json({ error: "No chart data" }, { status: 404 });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
