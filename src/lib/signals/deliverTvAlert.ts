import { randomUUID } from "node:crypto";

import { ensureRpsSnapshot, lookupAlertRps, resolveAlertTimeframe, type RpsEvidence } from "@/lib/backtest/rpsSnapshot";
import { renderSignalOgPng } from "@/lib/discord/signalCardOg";
import {
  alertTimeframeSuffix,
  buyPassesGate,
  rpsMinOf,
  type AlertPayload,
} from "@/lib/discord/tvAlertCopy";
import { STRATEGY_NAME } from "@/lib/discord/brand";
import { postSignalImage } from "@/lib/notifications/postSignalImage";
import { assessedAlertView } from "@/lib/signals/journal";
import type { SectorSnapshot } from "@/lib/signals/sectorFactor";
import { volumeFactorsOf } from "@/lib/signals/volumeFactors";

function tfLabel(period: string): string {
  const mins = Number(period);
  if (Number.isFinite(mins) && mins > 0) {
    return mins % 60 === 0 ? `${mins / 60}H` : `${mins}m`;
  }
  return period === "D" ? "日线" : period === "W" ? "周线" : period === "M" ? "月线" : period;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

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
  let rpsEvidence: RpsEvidence | undefined;
  let sector: SectorSnapshot | undefined;
  try {
    sector = (await ensureRpsSnapshot())?.sector;
    const quote = lookupAlertRps(payload.symbol, tf, new Date(isNum(payload.barTime) ? Math.min(payload.barTime, Date.now()) : Date.now()));
    rps = quote?.rps ?? null;
    if (quote) rpsEvidence = { asOf: quote.asOf, generatedAt: quote.generatedAt, sourceTimeframe: quote.sourceTimeframe, benchmark: quote.benchmark };
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }

  if (lookupError) console.warn("[tv-alert] rps-unavailable", payload.symbol, tf, lookupError);
  const volume = volumeFactorsOf(payload.volumeSnapshot, payload.barTime, payload.price);
  if (volume.cvd.points == null || volume.profile.points == null) {
    console.warn("[tv-alert] volume-incomplete", JSON.stringify({ symbol: payload.symbol, tf, signalProtocol: payload.signalProtocol ?? null,
      status: payload.volumeSnapshot === undefined ? "legacy-alert" : payload.volumeSnapshot == null ? "not-collected" : "invalid-snapshot",
      cvd: volume.cvd.reason, profile: volume.profile.reason }));
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

  // 重放旧买点不能把今天的截面排名写成历史入场评分。
  // 已存快照由 journal 原样复用；没存过的旧信号仅评可核对的技术部分。
  const timely = !isNum(payload.barTime) || (Date.now() - payload.barTime >= -60_000 && Date.now() - payload.barTime <= 15 * 60_000);
  const view = await assessedAlertView(payload, label, payload.event === "buy" && !timely ? undefined : rps ?? undefined, undefined, timely ? rpsEvidence : undefined,
    timely ? { sector } : undefined);
  const image = {
    kind: tf === "2h" ? "signal-2h" as const : "signal-4h" as const,
    filename: `signal-${payload.symbol}.png`,
    eventKey,
    bytes: await renderSignalOgPng(view),
    content: `**${STRATEGY_NAME} ${view.title} · ${payload.symbol}**${alertTimeframeSuffix(label)}`,
  };
  await postSignalImage(webhookUrl, image);
  return {
    ok: true,
    forwarded: true,
    gate: payload.event === "buy" ? "pass" : undefined,
    rps,
    lookupError,
  };
}
