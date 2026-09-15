import { NextResponse } from "next/server";

import type { GexSnapshot } from "@/lib/discord/gexCopy";
import { postSignalImage } from "@/lib/notifications/postSignalImage";
import { renderDailyDigestPng } from "@/lib/optionFlow/cardImage";
import {
  buildDailyFlowDigest,
  flowDigestCaption,
  hasDigestContent,
  type FlowDigestView,
} from "@/lib/optionFlow/digest";
import { readOptionFlow } from "@/lib/optionFlow/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body = {
  filename?: string;
  content?: string;
  test?: boolean;
  snapshot?: GexSnapshot;
  input?: FlowDigestView;
};

function isDigestView(value: unknown): value is FlowDigestView {
  return Boolean(value && typeof value === "object" && typeof (value as FlowDigestView).day === "string" && Array.isArray((value as FlowDigestView).legs));
}

export async function POST(request: Request) {
  const webhook = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || "";
  let body: Body = {};
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }
  try {
    const view = isDigestView(body.input)
      ? body.input
      : buildDailyFlowDigest((await readOptionFlow()).posts, body.snapshot);
    if (!hasDigestContent(view)) {
      return NextResponse.json({ ok: true, skipped: true });
    }
    const filename = body.filename || "option-flow-digest.png";
    const content = body.content ?? flowDigestCaption(Boolean(body.test));
    await postSignalImage(webhook, {
      kind: "option-flow-digest",
      filename,
      eventKey: JSON.stringify([filename, content, view.day, view.legs, view.spy, view.notes]),
      bytes: await renderDailyDigestPng(view),
      content,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "出图失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
