import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TelegramClient, TelegramError } from "@/lib/telegram/client";
import { TelegramStore } from "@/lib/telegram/store";
import { processTelegramUpdate, type TelegramUpdate } from "@/lib/telegram/updates";
import { deliverTelegram } from "@/lib/telegram/delivery";
import { createTelegramRelayServer } from "@/lib/telegram/relayServer";

const configFile = process.env.TELEGRAM_CONFIG_PATH || "/config/telegram.config.mjs";
// 服务器专用配置代码包含 Token 常量，独立挂载，不打入公开构建产物。
const config: { token?: string; relaySecret?: string; identityPrivateKey?: string } = existsSync(configFile) ? (await import(pathToFileURL(configFile).href)).default : {};
const token = config.token || process.env.TELEGRAM_BOT_TOKEN || "";
const secret = config.relaySecret || process.env.TELEGRAM_RELAY_SECRET || "";
const configured = !!token && (!!secret || !!config.identityPrivateKey);
const store = new TelegramStore(process.env.TELEGRAM_DATA_DIR || "/data");
const api = new TelegramClient(token);
let bot: { id: number; username: string } | undefined;
let lastPollAt = 0;
let running = true;
const logError = (name: string, e: unknown) => console.error(`[telegram] ${name}: ${e instanceof TelegramError ? e.message : "operation failed"}`);

const server = createTelegramRelayServer(store, secret, configured, () => ({ ok: !!bot && Date.now() - lastPollAt < 120_000, username: bot?.username }), config.identityPrivateKey);
server.listen(Number(process.env.PORT || 8082), "0.0.0.0", () => console.info(`[telegram] listening ${Number(process.env.PORT || 8082)} configured=${configured}`));

async function poll() {
  while (running) {
    try {
      if (!bot) {
        const info = await api.call<{ url: string }>("getWebhookInfo");
        if (info.url) throw new Error("Existing webhook; polling not started");
        bot = await api.call<{ id: number; username: string }>("getMe");
        console.info(`[telegram] @${bot.username} connected`);
      }
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
process.on("SIGTERM", () => { running = false; server.close(); });
