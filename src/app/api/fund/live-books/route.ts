import { NextResponse } from "next/server";

import { peekLiveBooks, refreshLiveBooks } from "@/lib/fund/liveBooks";
import { readBookEpoch } from "@/lib/fund/bookEpoch";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  try {
    const cached = await peekLiveBooks();
    if (cached) return NextResponse.json({ ok: true, ...cached });
    const epoch = await readBookEpoch();
    return NextResponse.json({
      ok: true,
      fromCache: false,
      stale: false,
      computedAt: null,
      epochFrom: epoch.from,
      books: [],
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取账本失败" },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    return NextResponse.json({ ok: true, ...(await refreshLiveBooks()) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "跑账本失败" },
      { status: 500 },
    );
  }
}
