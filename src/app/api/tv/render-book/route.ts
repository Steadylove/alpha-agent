import { NextResponse } from "next/server";

import { renderCashBookPng } from "@/lib/discord/bookCardImage";
import { renderSignalPng } from "@/lib/discord/signalCardImage";
import { postDiscordImage } from "@/lib/discord/sendWebhook";
import type { CashBookView } from "@/lib/discord/bookCopy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

void renderSignalPng;

type Body = {
  filename?: string;
  content?: string;
  input?: CashBookView;
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
    await postDiscordImage(webhook, {
      filename: body.filename,
      bytes: await renderCashBookPng(body.input),
      content: body.content ?? "",
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "出图失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
