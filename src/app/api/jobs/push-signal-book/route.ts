import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json({ ready: true });
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  try {
    const { pushSignalBooks } = await import("@/lib/fund/pushSignalBook");
    const result = await pushSignalBooks({
      test: url.searchParams.get("test") === "1",
      lookback: url.searchParams.get("lookback") === "1",
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "推送失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
