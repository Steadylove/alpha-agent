import { NextResponse } from "next/server";
import { z } from "zod";
import { loadRuntimeConfig } from "@/lib/runtimeConfig";
import { getFundamentalPage } from "@/lib/fundamental/store";
import { symbolSchema } from "@/lib/fundamental/types";

export const dynamic = "force-dynamic";

/** Reads saved state only. Collection and model calls belong to the background job. */
export async function GET(request: Request, { params }: { params: Promise<{ symbol: string }> }) {
  const { symbol: rawSymbol } = await params;
  const symbol = symbolSchema.safeParse(rawSymbol.trim().toUpperCase());
  const rawEntry = new URL(request.url).searchParams.get("entryAt");
  const entry = rawEntry === null ? null : z.iso.datetime({ offset: true }).safeParse(rawEntry);
  if (!symbol.success || (entry && !entry.success) || (entry?.success && new Date(entry.data).getTime() > Date.now())) {
    return NextResponse.json({ error: "标的或入场时间无效；入场时间须为带时区的 ISO 时间，且不能晚于当前时间。" }, { status: 400 });
  }
  try {
    await loadRuntimeConfig();
    const data = await getFundamentalPage(symbol.data, { entryAt: entry?.success ? new Date(entry.data).toISOString() : undefined });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "暂时无法读取估值快照" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
