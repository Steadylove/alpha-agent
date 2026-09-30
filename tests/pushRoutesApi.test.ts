import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GET, PUT } from "@/app/api/push-routes/route";
import * as atomicJson from "@/lib/files/atomicJson";
import { defaultPushRoutes, DISCORD_DEST_META, readPushRoutes, resolveDiscordTargets } from "@/lib/notifications/pushRoutes";

vi.mock("@/lib/runtimeConfig", () => ({ loadRuntimeConfig: vi.fn() }));
vi.mock("@/lib/telegram/relay", () => ({ telegramRelayTargets: vi.fn(async () => ({ ok: false, groups: [] })) }));

let root = "";
let file = "";
const defaultWebhook = "https://discord.com/api/webhooks/999/default-fixture";
const request = (body: unknown) => new Request("http://localhost/api/push-routes", { method: "PUT", body: JSON.stringify(body) });

function legacyConfig() {
  const defaults = defaultPushRoutes();
  return {
    ...defaults,
    updatedAt: "2026-09-29T00:00:00.000Z",
    routes: Object.fromEntries(Object.entries(defaults.routes)
      .filter(([kind]) => kind !== "signal-intraday")
      .map(([kind, route], index) => [kind, {
        ...route,
        discordWebhooks: [`https://discord.com/api/webhooks/${index + 1}/saved-fixture`],
      }])),
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "push-routes-api-"));
  file = path.join(root, "routes.json");
  vi.stubEnv("PUSH_ROUTES_PATH", file);
  for (const { env } of Object.values(DISCORD_DEST_META)) vi.stubEnv(env, "");
  writeFileSync(file, JSON.stringify(legacyConfig()));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it.each(["[REDACTED]", "[SENSITIVE]"])("旧配置缺少日内路由时，默认占位符 %s 不污染 GET 草稿，金额仍可保存", async (placeholder) => {
  vi.stubEnv("DISCORD_SIGNAL_WEBHOOK_URL", placeholder);
  const previous = legacyConfig();
  const previousFile = readFileSync(file, "utf8");
  const response = await GET();
  expect(response.status).toBe(200);
  const board = await response.json();
  expect(board.updatedAt).toBe(previous.updatedAt);
  expect(board.routes["signal-intraday"].discordWebhooks).toEqual([]);
  expect(board.routes["signal-intraday"].discordHooks).toEqual([{ label: "#常规", url: "" }]);
  expect(readFileSync(file, "utf8")).toBe(previousFile);

  const saved = await PUT(request({ ...board, optionFlowMinPremiumUsd: 1_000_000 }));
  expect(saved.status).toBe(200);
  const stored = await readPushRoutes({ strict: true });
  expect(stored.optionFlowMinPremiumUsd).toBe(1_000_000);
  expect(stored.routes["signal-intraday"]).toEqual(defaultPushRoutes().routes["signal-intraday"]);
  for (const [kind, route] of Object.entries(previous.routes)) expect(stored.routes).toHaveProperty(kind, route);
});

it("合法默认地址仍会填充新增路由并持久化，不覆盖已有路由", async () => {
  vi.stubEnv("DISCORD_SIGNAL_WEBHOOK_URL", defaultWebhook);
  const previous = legacyConfig();
  const board = await (await GET()).json();
  expect(board.routes["signal-intraday"].discordWebhooks).toEqual([defaultWebhook]);
  expect(board.routes["signal-intraday"].enabled).toBe(false);
  const hydrated = await readPushRoutes({ strict: true });
  expect(hydrated.routes["signal-intraday"].discordWebhooks).toEqual([defaultWebhook]);
  for (const [kind, route] of Object.entries(previous.routes)) expect(hydrated.routes).toHaveProperty(kind, route);

  expect((await PUT(request({ ...board, optionFlowMinPremiumUsd: 2_000_000 }))).status).toBe(200);
  expect((await readPushRoutes({ strict: true })).routes).toEqual(hydrated.routes);
});

it("主频道默认无效时不单独灌入有效镜像，避免改变主频道和标签", async () => {
  vi.stubEnv("DISCORD_SIGNAL_WEBHOOK_URL", "[REDACTED]");
  vi.stubEnv("DISCORD_MIRROR_4H_WEBHOOK_URL", "https://discord.com/api/webhooks/888/mirror-fixture");
  const previous = legacyConfig();
  previous.routes["signal-4h"].discordWebhooks = [];
  writeFileSync(file, JSON.stringify(previous));
  const previousFile = readFileSync(file, "utf8");

  const board = await (await GET()).json();
  expect(board.routes["signal-4h"].discordWebhooks).toEqual([]);
  expect(board.routes["signal-4h"].discordHooks).toEqual([
    { label: "#常规", url: "" },
    { label: "4H 镜像", url: "" },
  ]);
  expect(readFileSync(file, "utf8")).toBe(previousFile);
  expect((await PUT(request({ ...board, optionFlowMinPremiumUsd: 1_000_000 }))).status).toBe(200);
  expect((await readPushRoutes({ strict: true })).routes["signal-4h"]).toEqual(previous.routes["signal-4h"]);
});

it.each([
  "[REDACTED]",
  "https://example.invalid/api/webhooks/2/private-fixture-token",
  "https://discord.com/api/v10/webhooks/2/private-fixture-token",
  "https://fake-user:fake-password@discord.com/api/webhooks/2/private-fixture-token",
  "x".repeat(400),
])("无效地址可保存，但只跳过该地址，不影响其他配置：%s", async (invalidWebhook) => {
  const board = await (await GET()).json();
  const previous = (await readPushRoutes({ strict: true })).routes;
  board.routes.gex.discordWebhooks.push(invalidWebhook);
  const response = await PUT(request({ ...board, optionFlowMinPremiumUsd: 1_000_000 }));
  expect(response.status).toBe(200);
  const stored = await readPushRoutes({ strict: true });
  expect(stored.optionFlowMinPremiumUsd).toBe(1_000_000);
  expect(stored.routes.gex.discordWebhooks).toEqual([...previous.gex.discordWebhooks, invalidWebhook]);
  expect(resolveDiscordTargets(stored.routes.gex, () => defaultWebhook)).toEqual([
    { url: previous.gex.discordWebhooks[0], mirror: false },
  ]);
  for (const [kind, route] of Object.entries(previous)) {
    if (kind !== "gex") expect(stored.routes).toHaveProperty(kind, route);
  }
  const loaded = await (await GET()).json();
  expect(loaded.routes.gex.discordHooks.at(-1).url).toBe(invalidWebhook);
  loaded.routes.book.enabled = false;
  expect((await PUT(request(loaded))).status).toBe(200);
  expect((await readPushRoutes({ strict: true })).routes.book.enabled).toBe(false);
});

it.each([
  { webhooks: ["", "[SENSITIVE]"] },
  { webhooks: ["x".repeat(400)] },
])("全部地址无效时仍可保存，且不能改投默认频道：$webhooks", async ({ webhooks }) => {
  const board = await (await GET()).json();
  board.routes.gex.discordWebhooks = webhooks;
  const response = await PUT(request(board));
  expect(response.status).toBe(200);
  const stored = await readPushRoutes({ strict: true });
  expect(stored.routes.gex.discordWebhooks.length).toBeGreaterThan(0);
  const lookup = vi.fn(() => defaultWebhook);
  expect(resolveDiscordTargets(stored.routes.gex, lookup)).toEqual([]);
  expect(lookup).not.toHaveBeenCalled();
});

it("校验仍忽略原本不会保存为地址的值", async () => {
  const board = await (await GET()).json();
  const webhooks = Array.from({ length: 8 }, (_, index) => `https://discord.com/api/webhooks/${index + 1}/retained-fixture`);
  board.routes.gex.discordWebhooks = [null, 42, " ", ...webhooks, "[SENSITIVE]"];
  const response = await PUT(request(board));
  expect(response.status).toBe(200);
  expect((await readPushRoutes({ strict: true })).routes.gex.discordWebhooks).toEqual(webhooks);
});

it.each([false, true])("旧版本保存仍返回 409 且不覆盖配置（带非法地址：%s）", async (invalidWebhook) => {
  const board = await (await GET()).json();
  const previous = readFileSync(file, "utf8");
  if (invalidWebhook) board.routes.gex.discordWebhooks = ["[SENSITIVE]"];
  const response = await PUT(request({ ...board, updatedAt: "2026-09-28T00:00:00.000Z" }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "配置已被其他操作更新，请刷新后重试" });
  expect(readFileSync(file, "utf8")).toBe(previous);
});

it("真正的存储故障仍返回 500", async () => {
  const board = await (await GET()).json();
  vi.spyOn(atomicJson, "writeJsonAtomic").mockImplementation(() => { throw new Error("fixture storage failure"); });
  const response = await PUT(request({ ...board, optionFlowMinPremiumUsd: 1_000_000 }));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "fixture storage failure" });
});
