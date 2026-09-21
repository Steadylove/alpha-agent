/**
 * TradingView 告警中转：补上截面 RPS 闸门，再同步到 Discord 和 Telegram。
 *
 * TV webhook 大约 3 秒超时且不重试。这里先回 200，出图和推送放在 `after()` 里。
 *
 * Pine 只算得出单标的自足的信号，`rps >= rpsMin` 要把当日全池一起排名。
 * 分位读构建时的 `data/rps-latest.json`（或行情机上的快照）。
 *
 * 买点：查不到 / 未排名 / 不过门槛 → 不转发。过门文案写该股相对大池的分位
 * （「强于 79%」），不写门槛、一买/二买、RPS 数字、「未达标」。
 * 卖点照推，同样补分位和 ATR，标题也不带一买/二买。
 */

import { after, NextResponse } from "next/server";
import type { AlertPayload } from "@/lib/discord/tvAlertCopy";
import { EXIT_REASONS } from "@/lib/signals/assessment";
import { deliverTvAlert } from "@/lib/signals/deliverTvAlert";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parsePayload(raw: unknown): AlertPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (p.event !== "buy" && p.event !== "sell") return null;
  if (typeof p.symbol !== "string" || !p.symbol) return null;
  if (typeof p.tf !== "string") return null;
  if (!isNum(p.price) || p.price <= 0) return null;
  if (p.exitReason != null && (typeof p.exitReason !== "string" || !Object.hasOwn(EXIT_REASONS, p.exitReason))) return null;
  return p as unknown as AlertPayload;
}

export async function POST(request: Request) {
  const webhookUrl = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || "";

  let payload: AlertPayload | null = null;
  try {
    payload = parsePayload(JSON.parse(await request.text()));
  } catch {
    payload = null;
  }
  if (!payload) {
    return NextResponse.json({ error: "Malformed alert payload." }, { status: 400 });
  }

  after(() =>
    deliverTvAlert(payload, webhookUrl).catch((error) => {
      console.error("[tv-alert]", error instanceof Error ? error.message : error);
    }),
  );
  return NextResponse.json({ ok: true, accepted: true });
}
