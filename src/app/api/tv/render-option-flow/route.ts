import { NextResponse } from "next/server";

import { postSignalImage } from "@/lib/notifications/postSignalImage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  filename?: string;
  content?: string;
  eventKey?: string;
  png?: string;
};

export async function POST(request: Request) {
  const webhook = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || "";
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }
  if (!body.png || !body.filename) {
    return NextResponse.json({ error: "缺少 png / filename" }, { status: 400 });
  }
  try {
    await postSignalImage(webhook, {
      kind: "option-flow",
      filename: body.filename,
      eventKey: body.eventKey,
      bytes: Buffer.from(body.png, "base64"),
      content: body.content ?? "期权流 · 单笔",
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "推送失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
