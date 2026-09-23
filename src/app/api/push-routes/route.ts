import { NextResponse } from "next/server";

import { loadPushBoard, pushRoutesOf, readPushRoutes, validFlowMinPremium, writePushRoutes } from "@/lib/notifications/pushRoutes";
import { telegramRelayTargets } from "@/lib/telegram/relay";

export const dynamic = "force-dynamic";

export async function GET() {
  const routes = await loadPushBoard();
  const telegram = await telegramRelayTargets().catch(() => ({ ok: false, groups: [] as const }));
  return NextResponse.json({
    ok: true,
    updatedAt: routes.updatedAt,
    optionFlowMinPremiumUsd: routes.optionFlowMinPremiumUsd,
    routes: routes.routes,
    telegram: {
      ok: telegram.ok === true,
      username: "username" in telegram ? telegram.username : undefined,
      groups: telegram.groups ?? [],
    },
  });
}

export async function PUT(request: Request) {
  let body: { routes?: unknown; updatedAt?: unknown; optionFlowMinPremiumUsd?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "无效配置" }, { status: 400 });
  if (body.optionFlowMinPremiumUsd !== undefined && !validFlowMinPremium(body.optionFlowMinPremiumUsd)) {
    return NextResponse.json({ error: "金额门槛须为 0 至 1 万亿美元之间的整数美元" }, { status: 400 });
  }
  try {
    const previous = await readPushRoutes({ strict: true });
    const saved = await writePushRoutes(
      pushRoutesOf({ routes: body.routes ?? previous.routes, updatedAt: "", optionFlowMinPremiumUsd: body.optionFlowMinPremiumUsd ?? previous.optionFlowMinPremiumUsd }),
      typeof body.updatedAt === "string" ? body.updatedAt : "",
    );
    return NextResponse.json({ ok: true, updatedAt: saved.updatedAt, optionFlowMinPremiumUsd: saved.optionFlowMinPremiumUsd, routes: saved.routes });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    const conflict = message.includes("已被其他操作更新");
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}
