import { createHash } from "node:crypto";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { relayHeaders } from "./relayAuth";

function config() {
  const base = process.env.TELEGRAM_RELAY_URL || (marketBaseUrl() ? `${marketBaseUrl()}/telegram` : "");
  const secret = (process.env.TELEGRAM_RELAY_SECRET || process.env.CRON_SECRET || "").trim();
  return { base: base.replace(/\/$/, ""), secret };
}

async function requestRelay(path: string, body?: string) {
  const { base, secret } = config();
  if (!base || !secret) throw new Error("Telegram 推送服务未配置");
  let response: Response;
  try {
    response = await fetch(`${base}/${path}`, { method: body == null ? "GET" : "POST", cache: "no-store",
      headers: { "content-type": "application/json", ...relayHeaders(secret, body) }, body, signal: AbortSignal.timeout(15_000) });
  } catch { throw new Error("Telegram 推送服务暂时不可达"); }
  if (!response.ok) throw new Error(`Telegram 推送服务 HTTP ${response.status}`);
  return response.json() as Promise<{ ok: boolean; duplicate?: boolean; recipients?: number; username?: string; subscribed?: number }>;
}

export function telegramRelayStatus() { return requestRelay("status"); }

export async function enqueueTelegramImage(input: { filename: string; content?: string; bytes: Buffer; eventKey?: string }) {
  if (!config().base || process.env.TELEGRAM_ENABLED === "false") return { skipped: true };
  const id = createHash("sha256").update(input.eventKey ?? `${input.filename}\n${input.content ?? ""}`).update(input.eventKey ? "" : input.bytes).digest("hex");
  const content = (input.content ?? "").replace(/\*\*([^*]+)\*\*/g, "$1");
  if (content.length > 1024) throw new Error("Telegram 图片说明超过 1024 字符");
  return requestRelay("enqueue", JSON.stringify({ id, content, png: input.bytes.toString("base64") }));
}
