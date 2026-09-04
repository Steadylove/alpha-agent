import { NextResponse } from "next/server";

import { champOf } from "@/lib/fund/champs";
import { runFrozenLab } from "@/lib/fund/frozenLab";

export const dynamic = "force-dynamic";

const memo = new Map<string, Promise<Awaited<ReturnType<typeof runFrozenLab>>>>();

function frozenOf(id: string) {
  const champ = champOf(id);
  const hit = memo.get(champ.id);
  if (hit) return hit;
  const task = runFrozenLab(champ.id).catch((error) => {
    memo.delete(champ.id);
    throw error;
  });
  memo.set(champ.id, task);
  return task;
}

export async function GET(request: Request) {
  const tf = new URL(request.url).searchParams.get("tf");
  try {
    return NextResponse.json(await frozenOf(tf ?? "4h"));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "回测失败" },
      { status: 500 },
    );
  }
}
