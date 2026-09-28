import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TelegramClient, TelegramError } from "@/lib/telegram/client";
import { TelegramStore } from "@/lib/telegram/store";
import { processTelegramUpdate, type TelegramUpdate } from "@/lib/telegram/updates";
import { deliverTelegram } from "@/lib/telegram/delivery";
import { createTelegramRelayServer } from "@/lib/telegram/relayServer";
import { IntradayStore } from "@/lib/intraday/store";
import { deliverIntraday } from "@/lib/intraday/delivery";
import { DISCORD_DEST_META, pushRoutesOf } from "@/lib/notifications/pushRoutesLogic";
import { webSecrets } from "@/lib/runtimeConfig";

const configFile = process.env.TELEGRAM_CONFIG_PATH || "/config/telegram.config.mjs";
// 服务器专用配置代码包含 Token 常量，独立挂载，不打入公开构建产物。
const config: { token?: string; relaySecret?: string; identityPrivateKey?: string; mode?: "polling" | "webhook"; webhookSecret?: string; intradayWebhookSecret?: string } = existsSync(configFile) ? (await import(pathToFileURL(configFile).href)).default : {};
const token = config.token || process.env.TELEGRAM_BOT_TOKEN || "";
const secret = config.relaySecret || process.env.TELEGRAM_RELAY_SECRET || "";
const configured = !!token && (!!secret || !!config.identityPrivateKey);
const webhookMode = config.mode === "webhook";
const store = new TelegramStore(process.env.TELEGRAM_DATA_DIR || "/data");
let intradayStore: IntradayStore | undefined;
try { intradayStore = new IntradayStore(path.join(process.env.TELEGRAM_DATA_DIR || "/data", "intraday")); }
catch { console.error("[intraday] archive unavailable; ingestion disabled, existing Telegram service continues"); }
const privateSecrets = () => JSON.parse(readFileSync(path.join(path.dirname(configFile), "web-secrets.json"), "utf8"));
const api = new TelegramClient(token);
let bot: { id: number; username: string } | undefined;
let lastPollAt = 0;
let running = true;
const logError = (name: string, e: unknown) => console.error(`[telegram] ${name}: ${e instanceof TelegramError ? e.message : "operation failed"}`);

let updatesQueue = Promise.resolve();
const server = createTelegramRelayServer(store, secret, configured, () => ({ ok: !!bot && (webhookMode || Date.now() - lastPollAt < 120_000), username: bot?.username }), config.identityPrivateKey,
  webhookMode && config.webhookSecret ? { secret: config.webhookSecret, handle: (update) => {
    const work = updatesQueue.then(() => processTelegramUpdate(store, api, bot!, update));
    updatesQueue = work.catch(() => {});
    return work;
  } } : undefined, privateSecrets, intradayStore ? { store: intradayStore, secret: config.intradayWebhookSecret || "" } : undefined);
server.listen(Number(process.env.PORT || 8082), "0.0.0.0", () => console.info(`[telegram] listening ${Number(process.env.PORT || 8082)} configured=${configured}`));

async function poll() {
  while (running) {
    try {
      if (!bot) {
        if (!webhookMode) {
          const info = await api.call<{ url: string }>("getWebhookInfo");
          if (info.url) throw new Error("Existing webhook; polling not started");
        }
        bot = await api.call<{ id: number; username: string }>("getMe");
        console.info(`[telegram] @${bot.username} connected`);
      }
      if (webhookMode) { await sleep(30_000); continue; }
      const updates = await api.call<TelegramUpdate[]>("getUpdates", { offset: store.state.offset, timeout: 25, allowed_updates: ["message", "my_chat_member"] });
      for (const update of updates) await processTelegramUpdate(store, api, bot, update);
      lastPollAt = Date.now();
    } catch (e) { logError("poll", e); await sleep(e instanceof TelegramError && e.retryAfter ? e.retryAfter * 1000 : 5000); }
  }
}
async function send() {
  while (running) {
    try { await sleep(bot && await deliverTelegram(store, api) ? 45 : 500); }
    catch (e) { logError("delivery", e); await sleep(1000); }
  }
}
if (configured) { void poll(); void send(); }
async function sendIntraday() {
  const archive = intradayStore;
  if (!archive) return;
  while (running) {
    try {
      await deliverIntraday(archive, store, () => {
        const values = webSecrets(privateSecrets());
        const file = "/desk/push-routes.json";
        const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid push routes");
        return { file: pushRoutesOf(raw), lookup: (dest) =>
          dest === "main" ? values.DISCORD_SIGNAL_WEBHOOK_URL || values.DISCORD_WEBHOOK_URL || "" : values[DISCORD_DEST_META[dest].env as keyof typeof values] || "" };
      }, Boolean(bot));
    } catch { console.error("[intraday] outbox processing failed; records retained"); }
    await sleep(250);
  }
}
if (configured) void sendIntraday();
process.on("SIGTERM", () => { running = false; server.close(); });
