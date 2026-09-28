import { createHash } from "node:crypto";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { relayHeaders } from "./relayAuth";
import { getVercelOidcToken } from "@vercel/oidc";
import { sealRelayIdentity } from "./relayIdentity";
import { timingSafeEqual } from "node:crypto";

export class RelayHttpError extends Error {
  constructor(public status: number) { super(`Telegram 推送服务 HTTP ${status}`); }
}

function config() {
  const base = process.env.TELEGRAM_RELAY_URL || (marketBaseUrl() ? `${marketBaseUrl()}/telegram` : "");
  const secret = (process.env.TELEGRAM_RELAY_SECRET || "").trim();
  return { base: base.replace(/\/$/, ""), secret };
}

async function requestRelay(path: string, body?: string, sourceSecret?: string, timeoutMs = 15_000) {
  const { base, secret } = config();
  if (!base) throw new Error("Telegram 推送服务未配置");
  let auth: Record<string, string>;
  if (process.env.VERCEL) {
    try { auth = { "x-relay-identity": await sealRelayIdentity(await getVercelOidcToken(), body, undefined, undefined, sourceSecret) }; }
    catch { throw new Error("无法获取 Vercel 服务身份"); }
  } else {
    if (!secret || secret === "change-me") throw new Error("Telegram 推送服务未配置");
    auth = relayHeaders(secret, body);
  }
  let response: Response;
  try {
    response = await fetch(`${base}/${path}`, { method: body == null ? "GET" : "POST", cache: "no-store",
      headers: { "content-type": "application/json", ...auth }, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw new Error("Telegram 推送服务暂时不可达"); }
  if (!response.ok) throw new RelayHttpError(response.status);
  return response.json() as Promise<{ ok: boolean; duplicate?: boolean; recipients?: number; username?: string; subscribed?: number }>;
}

export function telegramRelayStatus() { return requestRelay("status"); }
export function relayTelegramUpdate(body: string, sourceSecret: string) { return requestRelay("updates", body, sourceSecret); }

export function relayIntradaySignal(body: string, sourceSecret: string) {
  if (!process.env.VERCEL) {
    const expected = process.env.TV_INTRADAY_WEBHOOK_SECRET || "";
    if (!/^[a-f0-9]{64}$/.test(expected) || sourceSecret.length !== expected.length || !timingSafeEqual(Buffer.from(sourceSecret), Buffer.from(expected))) {
      throw new RelayHttpError(401);
    }
  }
  return requestRelay("intraday/ingest", body, sourceSecret, 2300);
}

export async function readIntradayJournal(date: string) {
  return await requestRelay("intraday/journal", JSON.stringify({ date })) as unknown as {
    ok: boolean; date: string; records: Array<import("../intraday/store").IntradayRecord & { telegramDeliveries: import("./store").Delivery[] }>;
  };
}

export type TelegramTarget = { id: string; title: string; subscribed: boolean; messageThreadId?: number };

export function telegramRelayTargets() {
  return requestRelay("targets") as Promise<{ ok: boolean; username?: string; groups?: TelegramTarget[] }>;
}

export async function enqueueTelegramImage(
  input: { filename: string; content?: string; bytes: Buffer; eventKey?: string },
  chatIds?: readonly string[],
) {
  if (!config().base || process.env.TELEGRAM_ENABLED === "false") return { skipped: true };
  const id = createHash("sha256").update(input.eventKey ?? `${input.filename}\n${input.content ?? ""}`).update(input.eventKey ? "" : input.bytes).digest("hex");
  const content = (input.content ?? "").replace(/\*\*([^*]+)\*\*/g, "$1");
  if (content.length > 1024) throw new Error("Telegram 图片说明超过 1024 字符");
  return requestRelay("enqueue", JSON.stringify({
    id,
    content,
    png: input.bytes.toString("base64"),
    ...(chatIds ? { chatIds: [...chatIds] } : {}),
  }));
}
