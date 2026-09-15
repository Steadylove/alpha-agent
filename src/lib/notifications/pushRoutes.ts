import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { deskRemoteUrl, readDeskJson, writeDeskJson } from "@/lib/fund/deskRemote";
import { writeJsonAtomic } from "@/lib/files/atomicJson";

import {
  DISCORD_DEST_META,
  PUSH_KINDS,
  defaultPushRoutes,
  hydrateDiscordWebhooks,
  isDiscordWebhookUrl,
  presentDiscordHookRows,
  pushRoutesOf,
  type DiscordDest,
  type PushKind,
  type PushRoutesFile,
} from "./pushRoutesLogic";

export * from "./pushRoutesLogic";

const REMOTE_FILE = "push-routes.json";

function envOf(name: string): string {
  return (process.env[name] || "").trim();
}

export function pushRoutesPath(): string {
  if (process.env.PUSH_ROUTES_PATH) return process.env.PUSH_ROUTES_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", REMOTE_FILE);
}

function usesRemoteStore(): boolean {
  return !process.env.PUSH_ROUTES_PATH && deskRemoteUrl(REMOTE_FILE) != null;
}

function readLocal(): PushRoutesFile {
  const file = pushRoutesPath();
  if (!existsSync(file)) return defaultPushRoutes();
  try {
    return pushRoutesOf(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return defaultPushRoutes();
  }
}

export async function readPushRoutes(): Promise<PushRoutesFile> {
  if (!usesRemoteStore()) return readLocal();
  try {
    return pushRoutesOf(await readDeskJson(REMOTE_FILE));
  } catch {
    return defaultPushRoutes();
  }
}

export async function writePushRoutes(next: PushRoutesFile, expectedUpdatedAt?: string): Promise<PushRoutesFile> {
  const previous = await readPushRoutes();
  if (expectedUpdatedAt != null && previous.updatedAt !== expectedUpdatedAt) {
    throw new Error("配置已被其他操作更新，请刷新后重试");
  }
  const parsed = pushRoutesOf(next);
  for (const kind of Object.keys(parsed.routes) as PushKind[]) {
    if (parsed.routes[kind].discordWebhooks.some((url) => !isDiscordWebhookUrl(url))) {
      throw new Error("Discord webhook 地址无效");
    }
  }
  const saved: PushRoutesFile = { ...parsed, updatedAt: new Date().toISOString() };
  if (usesRemoteStore()) {
    await writeDeskJson(REMOTE_FILE, saved, expectedUpdatedAt);
    return saved;
  }
  writeJsonAtomic(pushRoutesPath(), saved);
  return saved;
}

export function discordWebhookOf(dest: DiscordDest, fallback = ""): string {
  if (dest === "main") return envOf("DISCORD_SIGNAL_WEBHOOK_URL") || envOf("DISCORD_WEBHOOK_URL") || fallback;
  if (dest === "screener") return envOf("DISCORD_WEBHOOK_URL") || envOf("DISCORD_SIGNAL_WEBHOOK_URL") || fallback;
  return envOf(DISCORD_DEST_META[dest].env);
}

export function presentPushBoard(file: PushRoutesFile) {
  return {
    updatedAt: file.updatedAt,
    routes: Object.fromEntries(
      PUSH_KINDS.map((kind) => {
        const item = file.routes[kind];
        return [kind, { ...item, discordHooks: presentDiscordHookRows(item) }];
      }),
    ),
  };
}

export async function loadPushBoard() {
  const stored = await readPushRoutes();
  const hydrated = hydrateDiscordWebhooks(stored, (dest) => discordWebhookOf(dest));
  const seeded = PUSH_KINDS.some((kind) => hydrated.routes[kind].discordWebhooks.length > stored.routes[kind].discordWebhooks.length);
  if (seeded) {
    try {
      return presentPushBoard(await writePushRoutes(hydrated, stored.updatedAt));
    } catch {
      return presentPushBoard(hydrated);
    }
  }
  return presentPushBoard(hydrated);
}
