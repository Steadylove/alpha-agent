import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json({ ready: true });
}

/** 转给 `/api/tv/alert`，和买卖点卡共用已经能出图的 sharp 函数包。 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const dest = new URL("/api/tv/alert", url.origin);
  dest.searchParams.set("book", "1");
  if (url.searchParams.get("test") === "1") dest.searchParams.set("test", "1");
  if (url.searchParams.get("lookback") === "1") dest.searchParams.set("lookback", "1");
  const res = await fetch(dest, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "book" }),
    cache: "no-store",
  });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
