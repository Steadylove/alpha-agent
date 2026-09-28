import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { TelegramStore } from "./store";
import { verifyRelay } from "./relayAuth";
import { openRelayIdentity } from "./relayIdentity";
import type { TelegramUpdate } from "./updates";
import { sealRuntimeConfig } from "../runtimeConfig";
import { IntradayStore, validDate } from "../intraday/store";
import { intradaySignalSchema } from "../intraday/protocol";

export function createTelegramRelayServer(store: TelegramStore, secret: string, configured: boolean,
  status: () => { ok: boolean; username?: string }, identityPrivateKey = "",
  webhook?: { secret: string; handle: (update: TelegramUpdate) => Promise<void> },
  runtimeSecrets?: () => unknown,
  intraday?: { store: IntradayStore; secret: string }) {
  return createServer(async (req, res) => {
    const reply = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    const route = req.url?.split("?")[0];
    if (req.method === "GET" && route === "/health") { reply(200, { ok: true, configured, runtimeConfig: Boolean(runtimeSecrets && identityPrivateKey), intradayConfigured: Boolean(intraday && /^[a-f0-9]{64}$/.test(intraday.secret)) }); return; }
    if (!configured) { reply(503, { error: "not configured" }); return; }
    if (!(req.method === "GET" && (route === "/status" || route === "/targets")) && !(req.method === "POST" && ["/enqueue", "/updates", "/runtime-config", "/intraday/ingest", "/intraday/journal"].includes(route ?? ""))) { reply(404, { error: "not found" }); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (route === "/runtime-config" ? 4096 : route?.startsWith("/intraday/") ? 16_384 : 8 * 1024 * 1024)) { reply(413, { error: "too large" }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const signed = route !== "/runtime-config" && secret !== "change-me" && verifyRelay(secret, String(req.headers["x-relay-time"] ?? ""), String(req.headers["x-relay-signature"] ?? ""), body);
      const identity = signed ? null : await openRelayIdentity(identityPrivateKey, String(req.headers["x-relay-identity"] ?? ""), body);
      if (!signed && !identity) { reply(401, { error: "unauthorized" }); return; }
      if (route?.startsWith("/intraday/")) {
        if (!intraday) { reply(503, { error: "intraday unavailable" }); return; }
        if (route === "/intraday/ingest") {
          // Local signed requests come from a trusted backend that has already verified the TV key.
          // Production OIDC requests carry the TV key inside the encrypted identity, never in the archive.
          const got = identity?.sourceSecret ?? "", expected = intraday.secret;
          if (!signed && (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(got) || !timingSafeEqual(Buffer.from(got), Buffer.from(expected)))) {
            reply(401, { error: "invalid webhook" }); return;
          }
          const parsed = intradaySignalSchema.safeParse(JSON.parse(body));
          if (!parsed.success) { reply(400, { error: "invalid signal" }); return; }
          reply(200, intraday.store.accept(parsed.data)); return;
        }
        const query = JSON.parse(body);
        if (!validDate(String(query?.date ?? ""))) { reply(400, { error: "invalid date" }); return; }
        const records = intraday.store.list(query.date).map(row => ({ ...row,
          telegramDeliveries: row.deliveries?.filter(d => d.jobId).flatMap(d => store.jobs.get(d.jobId!)?.deliveries ?? []) ?? [] }));
        reply(200, { ok: true, date: query.date, records }); return;
      }
      if (route === "/runtime-config") {
        if (!runtimeSecrets || !identity?.sourceSecret) { reply(503, { error: "configuration unavailable" }); return; }
        const encrypted = await sealRuntimeConfig(body, identity.sourceSecret, runtimeSecrets());
        res.writeHead(200, { "content-type": "application/jose", "cache-control": "no-store" });
        res.end(encrypted); return;
      }
      if (route === "/status") { reply(200, { ...status(), ...store.stats() }); return; }
      if (route === "/targets") { reply(200, { ...status(), groups: store.targets() }); return; }
      if (route === "/updates") {
        const got = identity?.sourceSecret ?? "", expected = webhook?.secret ?? "";
        if (!expected || got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) { reply(401, { error: "invalid webhook" }); return; }
        const update = JSON.parse(body) as TelegramUpdate;
        if (!update || !Number.isSafeInteger(update.update_id)) { reply(400, { error: "invalid update" }); return; }
        if (!status().ok) { reply(503, { error: "starting" }); return; }
        await webhook!.handle(update);
        reply(200, { ok: true }); return;
      }
      const data = JSON.parse(body) as { id?: unknown; content?: unknown; png?: unknown; chatIds?: unknown };
      const chatIds = data.chatIds === undefined ? undefined : Array.isArray(data.chatIds) && data.chatIds.every((id) => typeof id === "string" && id.length > 0 && id.length < 80)
        ? data.chatIds as string[]
        : null;
      if (!data || typeof data !== "object" || typeof data.id !== "string" || !/^[a-f0-9]{64}$/.test(data.id) || typeof data.content !== "string" || data.content.length > 1024 ||
        typeof data.png !== "string" || data.png.length > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.png) ||
        !Buffer.from(data.png, "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        chatIds === null) {
        reply(400, { error: "invalid image job" }); return;
      }
      // 未开始接收群事件前拒绝入队，避免把暂时未知的订阅群误当作空列表。
      if (!status().ok) { reply(503, { error: "starting" }); return; }
      const queued = store.enqueue(data.id, data.content, data.png, undefined, Date.now(), undefined, chatIds);
      console.info(`[telegram] enqueue id=${data.id.slice(0, 12)} recipients=${queued.recipients} duplicate=${queued.duplicate}`);
      reply(200, { ok: true, ...queued });
    } catch (e) { if (!res.writableEnded) reply(e instanceof SyntaxError ? 400 : 500, { error: "request failed" }); }
  });
}
