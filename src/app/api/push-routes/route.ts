import { NextResponse } from "next/server";

import { loadPushBoard, pushRoutesOf, writePushRoutes } from "@/lib/notifications/pushRoutes";
import { telegramRelayTargets } from "@/lib/telegram/relay";

export const dynamic = "force-dynamic";

export async function GET() {
  const routes = await loadPushBoard();
  const telegram = await telegramRelayTargets().catch(() => ({ ok: false, groups: [] as const }));
  return NextResponse.json({
    ok: true,
    updatedAt: routes.updatedAt,
    routes: routes.routes,
    telegram: {
      ok: telegram.ok === true,
      username: "username" in telegram ? telegram.username : undefined,
      groups: telegram.groups ?? [],
    },
  });
}

export async function PUT(request: Request) {
  let body: { routes?: unknown; updatedAt?: unknown } = {};
  try {
    body = (await request.json()) as { routes?: unknown; updatedAt?: unknown };
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }
  try {
    const saved = await writePushRoutes(
      pushRoutesOf({ routes: body.routes, updatedAt: "" }),
      typeof body.updatedAt === "string" ? body.updatedAt : "",
    );
    return NextResponse.json({ ok: true, updatedAt: saved.updatedAt, routes: saved.routes });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    const conflict = message.includes("已被其他操作更新");
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}
