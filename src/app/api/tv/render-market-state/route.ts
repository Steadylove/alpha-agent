import { NextResponse } from "next/server";

import { renderMarketStateOgPng } from "@/lib/discord/marketStateCardOg";
import type { MarketStateView } from "@/lib/discord/marketStateCopy";
import { postSignalImage } from "@/lib/notifications/postSignalImage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  filename?: string;
  content?: string;
  input?: MarketStateView;
};

export async function POST(request: Request) {
  const webhook = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) {
    return NextResponse.json({ error: "Discord webhook 未配置" }, { status: 503 });
  }
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }
  if (!body.input || !body.filename) {
    return NextResponse.json({ error: "缺少 input / filename" }, { status: 400 });
  }
  try {
    await postSignalImage(webhook, {
      filename: body.filename,
      eventKey: JSON.stringify([body.filename, body.content, body.input]),
      bytes: await renderMarketStateOgPng(body.input),
      content: body.content ?? "",
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "出图失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
