import { NextResponse } from "next/server";
import { telegramRelayStatus } from "@/lib/telegram/relay";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const status = await telegramRelayStatus();
    // 不公开群 ID、群名或消息内容。
    return NextResponse.json({ ok: status.ok, username: status.username, subscribed: status.subscribed });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Telegram unavailable" }, { status: 503 });
  }
}
