import { NextResponse } from "next/server";

import {
  deleteLookbackSnapshot,
  readLookbackSnapshots,
  renameLookbackSnapshot,
  saveLookbackSnapshot,
} from "@/lib/fund/lookbackSnapshots";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, snapshots: await readLookbackSnapshots() });
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }

  try {
    if (body.action === "delete") {
      if (typeof body.id !== "string" || !body.id) {
        return NextResponse.json({ error: "缺少快照 id" }, { status: 400 });
      }
      return NextResponse.json({ ok: true, snapshots: await deleteLookbackSnapshot(body.id) });
    }
    if (body.action === "rename") {
      if (typeof body.id !== "string" || !body.id) {
        return NextResponse.json({ error: "缺少快照 id" }, { status: 400 });
      }
      return NextResponse.json({ ok: true, snapshots: await renameLookbackSnapshot(body.id, body.name) });
    }
    if (body.action === "save") {
      return NextResponse.json({ ok: true, snapshots: await saveLookbackSnapshot(body) });
    }
    return NextResponse.json({ error: "action 必须是 save、rename 或 delete" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "写入失败" },
      { status: 400 },
    );
  }
}
