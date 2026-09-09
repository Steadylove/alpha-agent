import { NextResponse } from "next/server";

import { peekLiveBooks, refreshLiveBooks } from "@/lib/fund/liveBooks";
import { readBookEpoch } from "@/lib/fund/bookEpoch";
import { listLiveBookVersions, readLiveBookVersion, isBookVersionId } from "@/lib/fund/liveBooksStore";
import { withoutObsoleteTwoHour } from "@/lib/fund/liveBooksLogic";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.get("history") === "1") return NextResponse.json({ versions: (await listLiveBookVersions()).map(withoutObsoleteTwoHour) });
    const version = params.get("version");
    if (version) {
      if (!isBookVersionId(version)) return NextResponse.json({ error: "版本号无效" }, { status: 400 });
      const book = await readLiveBookVersion(version);
      return book ? NextResponse.json(withoutObsoleteTwoHour(book)) : NextResponse.json({ error: "找不到该版本" }, { status: 404 });
    }
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
