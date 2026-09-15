export const PUSH_KINDS = [
  "signal-4h",
  "signal-2h",
  "book",
  "gex",
  "option-flow",
  "option-flow-noteworthy",
  "option-flow-gex",
  "option-flow-digest",
  "screener",
] as const;

export type PushKind = (typeof PUSH_KINDS)[number];

export const DISCORD_DESTS = [
  "main",
  "screener",
  "mirror-4h",
  "mirror-2h",
  "mirror-gex",
  "mirror-book",
] as const;

export type DiscordDest = (typeof DISCORD_DESTS)[number];

export type PushRoute = {
  enabled: boolean;
  discord: boolean;
  telegram: boolean;
  discordDests: DiscordDest[];
  discordWebhooks: string[];
  telegramAll: boolean;
  telegramChats: string[];
};

export type PushRoutesFile = {
  updatedAt: string;
  routes: Record<PushKind, PushRoute>;
};

export const PUSH_KIND_META: Record<PushKind, { label: string; hint: string }> = {
  "signal-4h": { label: "买卖点 · 4 小时", hint: "TradingView 4H 买/卖卡" },
  "signal-2h": { label: "买卖点 · 2 小时", hint: "TradingView 2H 买/卖卡" },
  book: { label: "现金账本", hint: "日更账本 1 / 账本 2" },
  gex: { label: "GEX 简报", hint: "日更 GEX 卡" },
  "option-flow": { label: "期权流 · 单笔", hint: "Quill #option 完整单" },
  "option-flow-noteworthy": { label: "期权流 · 确认名单", hint: "noteworthy 列表卡" },
  "option-flow-gex": { label: "期权流 · 热力图", hint: "对方频道 GEX 图" },
  "option-flow-digest": { label: "期权流 · 日结", hint: "随 GEX 日更，默认不抄镜像" },
  screener: { label: "选股卡", hint: "精英池 + 新高池" },
};

export const DISCORD_DEST_META: Record<DiscordDest, { label: string; env: string }> = {
  main: { label: "#常规", env: "DISCORD_SIGNAL_WEBHOOK_URL" },
  screener: { label: "选股频道", env: "DISCORD_WEBHOOK_URL" },
  "mirror-4h": { label: "4H 镜像", env: "DISCORD_MIRROR_4H_WEBHOOK_URL" },
  "mirror-2h": { label: "2H 镜像", env: "DISCORD_MIRROR_2H_WEBHOOK_URL" },
  "mirror-gex": { label: "GEX 镜像", env: "DISCORD_MIRROR_GEX_WEBHOOK_URL" },
  "mirror-book": { label: "账本镜像", env: "DISCORD_MIRROR_BOOK_WEBHOOK_URL" },
};

function route(partial: Partial<PushRoute> & Pick<PushRoute, "discordDests" | "telegram">): PushRoute {
  return {
    enabled: partial.enabled !== false,
    discord: partial.discord !== false,
    telegram: partial.telegram,
    discordDests: destsOf(partial.discordDests),
    discordWebhooks: hooksOf(partial.discordWebhooks),
    telegramAll: partial.telegramAll !== false,
    telegramChats: chatsOf(partial.telegramChats),
  };
}

function destsOf(value: unknown): DiscordDest[] {
  const allowed = new Set<string>(DISCORD_DESTS);
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is DiscordDest => typeof item === "string" && allowed.has(item)))];
}

function hooksOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0 && item.length < 400))].slice(0, 8);
}

function chatsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length < 80))].slice(0, 50);
}

/** 旧配置只存群 id 时，勾上该群当前所有话题。带 # 的是精确话题。 */
export function expandTelegramChats(saved: string[], targetIds: string[]): string[] {
  return targetIds.filter((id) => saved.some((item) => item === id || (!item.includes("#") && (id === item || id.startsWith(`${item}#`)))));
}

export function defaultPushRoutes(): PushRoutesFile {
  return {
    updatedAt: "",
    routes: {
      "signal-4h": route({ discordDests: ["main", "mirror-4h"], telegram: true }),
      "signal-2h": route({ discordDests: ["main", "mirror-2h"], telegram: true }),
      book: route({ discordDests: ["main", "mirror-book"], telegram: true }),
      gex: route({ discordDests: ["main", "mirror-gex"], telegram: true }),
      "option-flow": route({ discordDests: ["main"], telegram: true }),
      "option-flow-noteworthy": route({ discordDests: ["main"], telegram: false }),
      "option-flow-gex": route({ discordDests: ["main"], telegram: false }),
      "option-flow-digest": route({ discordDests: ["main"], telegram: true }),
      screener: route({ discordDests: ["screener"], telegram: false }),
    },
  };
}

export function pushRoutesOf(raw: unknown): PushRoutesFile {
  const fallback = defaultPushRoutes();
  if (!raw || typeof raw !== "object") return fallback;
  const value = raw as { updatedAt?: unknown; routes?: unknown };
  const incoming = value.routes && typeof value.routes === "object" ? (value.routes as Record<string, Partial<PushRoute>>) : {};
  const routes = { ...fallback.routes };
  for (const kind of PUSH_KINDS) {
    const item = incoming[kind];
    if (!item || typeof item !== "object") continue;
    routes[kind] = route({
      ...fallback.routes[kind],
      ...item,
      discordDests: item.discordDests ?? fallback.routes[kind].discordDests,
      discordWebhooks: item.discordWebhooks ?? fallback.routes[kind].discordWebhooks,
      telegramChats: item.telegramChats ?? fallback.routes[kind].telegramChats,
    });
  }
  return {
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    routes,
  };
}

export function isMirrorDest(dest: DiscordDest): boolean {
  return dest.startsWith("mirror-");
}

export function isDiscordWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (!/^(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com$/.test(url.hostname)) return false;
    return /^\/api\/webhooks\/\d+\/[\w.-]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function resolveDiscordTargets(
  item: PushRoute,
  lookup: (dest: DiscordDest) => string,
): Array<{ url: string; mirror: boolean }> {
  if (item.discordWebhooks.length) {
    return [...new Set(item.discordWebhooks)].map((url, index) => ({ url, mirror: index > 0 }));
  }
  const rows = item.discordDests.map((dest) => ({ dest, url: lookup(dest) })).filter((row) => row.url);
  const hasPrimary = rows.some((row) => !isMirrorDest(row.dest));
  return rows.map((row) => ({ url: row.url, mirror: hasPrimary && isMirrorDest(row.dest) }));
}

export type DiscordHookRow = { label: string; url: string };

function destLabel(dest: DiscordDest | undefined, index: number): string {
  if (dest) return DISCORD_DEST_META[dest].label;
  return index === 0 ? "主频道" : `抄送 ${index}`;
}

export function presentDiscordHookRows(item: PushRoute): DiscordHookRow[] {
  if (item.discordWebhooks.length) {
    return item.discordWebhooks.map((url, index) => ({ label: destLabel(item.discordDests[index], index), url }));
  }
  return item.discordDests.map((dest) => ({ label: DISCORD_DEST_META[dest].label, url: "" }));
}

export function hydrateDiscordWebhooks(file: PushRoutesFile, lookup: (dest: DiscordDest) => string): PushRoutesFile {
  const routes = { ...file.routes };
  for (const kind of PUSH_KINDS) {
    const item = routes[kind];
    if (item.discordWebhooks.length) continue;
    const urls = [...new Set(item.discordDests.map((dest) => lookup(dest)).filter(Boolean))];
    if (urls.length) routes[kind] = { ...item, discordWebhooks: urls };
  }
  return { ...file, routes };
}

export function presentPushRoutes(file: PushRoutesFile, lookup: (dest: DiscordDest) => string): PushRoutesFile {
  const hydrated = hydrateDiscordWebhooks(file, lookup);
  const routes = { ...hydrated.routes };
  for (const kind of PUSH_KINDS) {
    const item = routes[kind];
    routes[kind] = { ...item, discordWebhooks: presentDiscordHookRows(item).map((row) => row.url).filter(Boolean) };
  }
  return { ...hydrated, routes };
}
