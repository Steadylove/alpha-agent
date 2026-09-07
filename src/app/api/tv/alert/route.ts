/**
 * TradingView 告警中转：补上截面 RPS 闸门，再转发 Discord。
 *
 * Pine 只算得出单标的自足的信号，`rps >= rpsMin` 要把当日全池一起排名。
 * 分位读构建时的 `data/rps-latest.json`（或行情机上的快照）。
 *
 * 买点：查不到 / 未排名 / 不过门槛 → 不转发。过门文案写该股相对大池的分位
 * （「强于 79%」），不写门槛、一买/二买、RPS 数字、「未达标」。
 * 卖点照推，标题也不带一买/二买。
 */

import { NextResponse } from "next/server";

import { ensureRpsSnapshot, lookupAlertRps, resolveAlertTimeframe } from "@/lib/backtest/rpsSnapshot";
import { renderSignalPng } from "@/lib/discord/signalCardImage";
import {
  buildAlertView,
  buyPassesGate,
  rpsMinOf,
  type AlertPayload,
} from "@/lib/discord/tvAlertCopy";
import { postDiscordImage } from "@/lib/discord/sendWebhook";

function tfLabel(period: string): string {
  const mins = Number(period);
  if (Number.isFinite(mins) && mins > 0) {
    return mins % 60 === 0 ? `${mins / 60}H` : `${mins}m`;
  }
  return period === "D" ? "日线" : period === "W" ? "周线" : period === "M" ? "月线" : period;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parsePayload(raw: unknown): AlertPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (p.event !== "buy" && p.event !== "sell") return null;
  if (typeof p.symbol !== "string" || !p.symbol) return null;
  if (typeof p.tf !== "string") return null;
  if (!isNum(p.price)) return null;
  return p as unknown as AlertPayload;
}

export async function POST(request: Request) {
  const webhookUrl = process.env.DISCORD_SIGNAL_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json(
      { error: "Neither DISCORD_SIGNAL_WEBHOOK_URL nor DISCORD_WEBHOOK_URL is configured." },
      { status: 503 },
    );
  }

  let payload: AlertPayload | null = null;
  try {
    payload = parsePayload(JSON.parse(await request.text()));
  } catch {
    payload = null;
  }
  if (!payload) {
    return NextResponse.json({ error: "Malformed alert payload." }, { status: 400 });
  }

  const label = tfLabel(payload.tf);
  const tf = resolveAlertTimeframe(payload.tf);
  const rpsMin = rpsMinOf(tf);

  if (payload.event === "sell") {
    const view = buildAlertView(payload, label);
    await postDiscordImage(webhookUrl, {
      filename: `signal-${payload.symbol}.png`,
      bytes: await renderSignalPng(view),
      content: `**${view.title} · ${payload.symbol}** · ${label}`,
    });
    return NextResponse.json({ ok: true, forwarded: true });
  }

  let rps: number | null = null;
  let lookupError: string | null = null;
  try {
    await ensureRpsSnapshot();
    rps = lookupAlertRps(payload.symbol, tf)?.rps ?? null;
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }

  if (!buyPassesGate(rps, rpsMin) || rps == null) {
    return NextResponse.json({
      ok: true,
      forwarded: false,
      gate: rps == null ? "unknown" : "reject",
      rps,
      lookupError,
    });
  }

  const view = buildAlertView(payload, label, rps);
  await postDiscordImage(webhookUrl, {
    filename: `signal-${payload.symbol}.png`,
    bytes: await renderSignalPng(view),
    content: `**${view.title} · ${payload.symbol}** · ${label}`,
  });
  return NextResponse.json({ ok: true, forwarded: true, gate: "pass", rps, lookupError });
}
