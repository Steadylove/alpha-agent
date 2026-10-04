import { NextResponse } from "next/server";
import { getFundamentalSummaries } from "@/lib/fundamental/summary";
import { symbolSchema } from "@/lib/fundamental/types";
import { loadRuntimeConfig } from "@/lib/runtimeConfig";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Reads saved summaries only; never collects financial data or generates analysis. */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("symbols");
  const symbols = [...new Set((raw ?? "").split(",").map(value => value.trim().toUpperCase()))];
  if (symbols.length > 20 || symbols.some(symbol => !symbolSchema.safeParse(symbol).success)) {
    return NextResponse.json({ error: "请提供 1 至 20 个有效股票代码。" }, { status: 400, headers });
  }
  try {
    await loadRuntimeConfig();
    return NextResponse.json({ rows: await getFundamentalSummaries(symbols) }, { headers });
  } catch {
    return NextResponse.json({ error: "暂时无法读取估值快照" }, { status: 503, headers });
  }
}
