import { loadRuntimeConfig } from "@/lib/runtimeConfig";
import { NextResponse } from "next/server";

import { buildSignalBooks } from "@/lib/fund/pushSignalBook";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  await loadRuntimeConfig();
  return NextResponse.json({ ready: true });
}

export async function POST(request: Request) {
  await loadRuntimeConfig();
  const url = new URL(request.url);
  try {
    const books = await buildSignalBooks({
      test: url.searchParams.get("test") === "1",
      lookback: url.searchParams.get("lookback") === "1",
      fromCache: url.searchParams.get("lookback") !== "1",
    });
    const dest = new URL("/api/tv/render-book", url.origin);
    const sent: string[] = [];
    const errors: string[] = [];
    for (const book of books) {
      try {
        const res = await fetch(dest, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(book),
          cache: "no-store",
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text.trim() || `出图失败 HTTP ${res.status}`);
        }
        const result = await res.json() as { skipped?: boolean };
        if (!result.skipped) sent.push(book.summary);
      } catch (error) {
        errors.push(`${book.filename}: ${error instanceof Error ? error.message : "推送失败"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (errors.length) return NextResponse.json({ error: errors.join("; "), sent }, { status: 500 });
    return NextResponse.json({ ok: true, sent });
  } catch (error) {
    const message = error instanceof Error ? error.message : "推送失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
