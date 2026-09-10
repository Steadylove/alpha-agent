import { NextResponse } from "next/server";
import { relayTelegramUpdate } from "@/lib/telegram/relay";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!/^[a-f0-9]{64}$/.test(secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (Number(request.headers.get("content-length")) > 1024 * 1024) return NextResponse.json({ error: "too large" }, { status: 413 });
  try {
    const body = await request.text();
    if (Buffer.byteLength(body) > 1024 * 1024) return NextResponse.json({ error: "too large" }, { status: 413 });
    const update = JSON.parse(body);
    if (!update || !Number.isSafeInteger(update.update_id)) return NextResponse.json({ error: "invalid update" }, { status: 400 });
    // 原始 Telegram 密钥装入加密的服务身份中，由 VPS 校验，不落日志。
    await relayTelegramUpdate(body, secret);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof SyntaxError ? "invalid JSON" : "receiver unavailable" }, { status: error instanceof SyntaxError ? 400 : 503 });
  }
}
