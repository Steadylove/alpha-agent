import { appConfig } from "../../../app.config";
import { isDiscordWebhookUrl, resolveDiscordTargets, type DiscordDest, type PushRoutesFile } from "@/lib/notifications/pushRoutesLogic";
import type { TelegramStore } from "@/lib/telegram/store";
import { digest, signalMessage } from "./protocol";
import { IntradayStore, type IntradayRecord } from "./store";

export type IntradayRoutes = { file: PushRoutesFile; lookup: (dest: DiscordDest) => string };

/** Durable outbox: a successful channel is never re-sent just because another channel failed. */
export async function deliverIntraday(store: IntradayStore, telegram: TelegramStore,
  routes: () => IntradayRoutes, telegramReady: boolean, now = Date.now(), fetcher: typeof fetch = fetch): Promise<boolean> {
  for (const original of store.pending.values()) {
    const row: IntradayRecord = structuredClone(original);
    const persist = () => { if (JSON.stringify(row) !== JSON.stringify(original)) store.save(row); };
    const expired = now - row.payload.signalTime > appConfig.intraday.maxDeliveryAgeMs;
    if (row.deliveries) {
      for (const d of row.deliveries) {
        if (d.state === "queued" && d.jobId) {
          const job = telegram.jobs.get(d.jobId);
          if (job && job.deliveries.every(t => t.state !== "pending")) {
            d.state = job.deliveries.every(t => t.state === "sent") ? "sent" : job.deliveries.some(t => t.state === "failed") ? "failed" : "skipped";
            d.error = d.state === "sent" ? undefined : "telegram_incomplete";
          }
        }
        if (expired && d.state === "pending") { d.state = "skipped"; d.error = "delivery_expired"; }
      }
      if (row.deliveries.every(d => d.state !== "pending" && d.state !== "queued")) {
        row.state = "done"; store.save(row); continue;
      }
    } else if (expired) {
      row.state = "skipped"; row.reason = "delivery_expired"; store.save(row); continue;
    }
    let config: IntradayRoutes;
    try { config = routes(); }
    catch { row.reason = "routing_unavailable"; persist(); continue; }
    if (row.reason === "routing_unavailable") delete row.reason;
    const route = config.file.routes["signal-intraday"];
    const targets = resolveDiscordTargets(route, config.lookup);
    const hooks = new Map(targets.map(t => [digest(t.url), t.url]));
    if (!row.deliveries) {
      row.routeUpdatedAt = config.file.updatedAt;
      if (!route.enabled) { row.state = "skipped"; row.reason = "route_disabled"; store.save(row); continue; }
      row.deliveries = [
        ...(route.discord ? (targets.length ? targets.map(t => ({ channel: "discord" as const, target: digest(t.url), state: "pending" as const, attempts: 0, nextAt: now })) :
          [{ channel: "discord" as const, target: "unconfigured", state: "failed" as const, attempts: 0, nextAt: now, error: "no_discord_destination" }]) : []),
        ...(route.telegram ? [{ channel: "telegram" as const, target: "telegram", state: "pending" as const, attempts: 0, nextAt: now }] : []),
      ];
      row.state = "tracking";
      row.reason = row.deliveries.length ? undefined : "no_destination";
      store.save(row);
    }
    const d = row.deliveries.find(t => t.state === "pending" && t.nextAt <= now && (t.channel !== "telegram" || telegramReady));
    if (!d) { persist(); continue; }
    if (!route.enabled || (d.channel === "discord" ? !route.discord : !route.telegram)) {
      d.state = "skipped"; d.error = "route_disabled"; store.save(row); return true;
    }
    const content = signalMessage(row.payload, row.id) + (row.payload.event !== "entry" && row.payload.event !== "watch" && !store.hasEntry(row.payload) ? "\n对应入场快照尚未收到，勿视为已确认的持仓" : "");
    d.attempts++; d.nextAt = now + Math.min(30_000, 1000 * 2 ** d.attempts);
    store.save(row); // preserve attempt before any external side effect
    if (d.channel === "telegram") {
      d.jobId = digest(["intraday", row.id]);
      const queued = telegram.enqueue(d.jobId, content, undefined, undefined, now, undefined,
        route.telegramAll ? undefined : route.telegramChats, row.payload.signalTime + appConfig.intraday.maxDeliveryAgeMs);
      d.state = queued.recipients ? "queued" : "failed";
      d.error = queued.recipients ? undefined : "no_telegram_destination";
    } else {
      const hook = hooks.get(d.target);
      if (!hook || !isDiscordWebhookUrl(hook)) { d.state = "skipped"; d.error = "destination_removed"; }
      else {
        try {
          const url = new URL(hook); url.searchParams.set("wait", "true");
          const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(5000), redirect: "error" });
          if (res.ok) {
            const body = await res.json().catch(() => null);
            d.state = "sent"; d.messageId = typeof body?.id === "string" ? body.id : undefined; delete d.error;
          } else {
            d.error = `http_${res.status}`;
            if (res.status === 429) {
              const body = await res.json().catch(() => null);
              d.nextAt = now + Math.max(1000, Math.min(180_000, Number(body?.retry_after || 1) * 1000));
            } else if (res.status < 500) d.state = "failed";
          }
        } catch { d.error = "delivery_unconfirmed"; }
      }
      if (d.state === "pending" && d.attempts >= appConfig.intraday.maxAttempts) d.state = "failed";
    }
    store.save(row);
    return true;
  }
  return false;
}
