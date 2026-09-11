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
import { randomUUID } from "node:crypto";

import { ensureRpsSnapshot, lookupAlertRps, resolveAlertTimeframe } from "@/lib/backtest/rpsSnapshot";
import { renderSignalOgPng } from "@/lib/discord/signalCardOg";
import {
  alertTimeframeSuffix,
  buildAlertView,
  buyPassesGate,
  rpsMinOf,
  type AlertPayload,
} from "@/lib/discord/tvAlertCopy";
import { STRATEGY_NAME } from "@/lib/discord/brand";
import { lookupAlertFundScore } from "@/lib/jobs/fundScore";
import { postSignalImage } from "@/lib/notifications/postSignalImage";

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

export type DeliveredAlert = {
  ok: true;
  forwarded: boolean;
  gate?: "unknown" | "reject" | "pass";
  rps?: number | null;
  lookupError?: string | null;
};

export async function deliverTvAlert(payload: AlertPayload, webhookUrl: string): Promise<DeliveredAlert> {
  const label = tfLabel(payload.tf);
  // 旧版告警没有 K 线时间时保留每次有效信号，不能按价格去重误吞后续交易。
  const eventKey = JSON.stringify(["tv", isNum(payload.barTime) ? payload.barTime : randomUUID(), payload]);
  const tf = resolveAlertTimeframe(payload.tf);
  const rpsMin = rpsMinOf(tf);

  let rps: number | null = null;
  let lookupError: string | null = null;
  try {
    await ensureRpsSnapshot();
    rps = lookupAlertRps(payload.symbol, tf)?.rps ?? null;
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }

  if (payload.event === "buy" && (!buyPassesGate(rps, rpsMin) || rps == null)) {
    return {
      ok: true,
      forwarded: false,
      gate: rps == null ? "unknown" : "reject",
      rps,
      lookupError,
    };
  }

  let fund;
  try {
    fund = await lookupAlertFundScore(payload.symbol);
  } catch {
    fund = undefined;
  }
  const view = buildAlertView(payload, label, rps ?? undefined, fund);
  await postSignalImage(webhookUrl, {
    filename: `signal-${payload.symbol}.png`,
    eventKey,
    bytes: await renderSignalOgPng(view),
    content: `**${STRATEGY_NAME} ${view.title} · ${payload.symbol}**${alertTimeframeSuffix(label)}`,
  });
  return {
    ok: true,
    forwarded: true,
    gate: payload.event === "buy" ? "pass" : undefined,
    rps,
    lookupError,
  };
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

  after(() =>
    deliverTvAlert(payload, webhookUrl).catch((error) => {
      console.error("[tv-alert]", error instanceof Error ? error.message : error);
    }),
  );
  return NextResponse.json({ ok: true, accepted: true });
}
