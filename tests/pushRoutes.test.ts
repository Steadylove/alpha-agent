import { expect, it } from "vitest";

import { defaultPushRoutes, expandTelegramChats, presentDiscordHookRows, presentPushRoutes, pushRoutesOf, resolveDiscordTargets } from "@/lib/notifications/pushRoutesLogic";

it("缺字段时补齐现网默认路由，不丢已知开关", () => {
  const parsed = pushRoutesOf({
    updatedAt: "2026-09-15T00:00:00.000Z",
    routes: {
      screener: { enabled: false, telegram: true, discordDests: ["screener", "main"], telegramAll: false, telegramChats: ["-100"] },
    },
  });
  expect(parsed.updatedAt).toBe("2026-09-15T00:00:00.000Z");
  expect(parsed.routes.screener).toMatchObject({ enabled: false, telegram: true, discordDests: ["screener", "main"], telegramChats: ["-100"] });
  expect(parsed.routes["signal-4h"]).toEqual(defaultPushRoutes().routes["signal-4h"]);
  expect(parsed.routes["option-flow-noteworthy"].telegram).toBe(false);
});

it("空对象等于现网默认：买卖点抄镜像，确认名单和热力图默认不发 Telegram", () => {
  const routes = pushRoutesOf({}).routes;
  expect(routes["signal-4h"].discordDests).toEqual(["main", "mirror-4h"]);
  expect(routes["option-flow-digest"].discordDests).toEqual(["main"]);
  expect(routes["option-flow-noteworthy"].telegram).toBe(false);
  expect(routes.screener.discordDests).toEqual(["screener"]);
});

it("没填 webhook 时按旧频道名解析环境变量", () => {
  const lookup = (dest: string) => dest === "main" ? "https://discord.com/api/webhooks/1/main" : dest === "mirror-4h" ? "https://discord.com/api/webhooks/1/4h" : "";
  const targets = resolveDiscordTargets(defaultPushRoutes().routes["signal-4h"], lookup);
  expect(targets).toEqual([
    { url: "https://discord.com/api/webhooks/1/main", mirror: false },
    { url: "https://discord.com/api/webhooks/1/4h", mirror: true },
  ]);
});

it("填了 webhook 就不再看频道名", () => {
  const parsed = pushRoutesOf({
    routes: { gex: { discordWebhooks: ["https://discord.com/api/webhooks/1/custom"], telegram: true } },
  });
  const targets = resolveDiscordTargets(parsed.routes.gex, () => "https://discord.com/api/webhooks/1/env");
  expect(targets).toEqual([{ url: "https://discord.com/api/webhooks/1/custom", mirror: false }]);
});

it("现用环境变量地址灌进配置后按频道名展示", () => {
  const lookup = (dest: string) => dest === "main" ? "https://discord.com/api/webhooks/1/main" : dest === "mirror-4h" ? "https://discord.com/api/webhooks/1/4h" : dest === "screener" ? "https://discord.com/api/webhooks/1/screener" : "";
  const presented = presentPushRoutes(defaultPushRoutes(), lookup);
  expect(presented.routes["signal-4h"].discordWebhooks).toEqual(["https://discord.com/api/webhooks/1/main", "https://discord.com/api/webhooks/1/4h"]);
  expect(presented.routes.screener.discordWebhooks).toEqual(["https://discord.com/api/webhooks/1/screener"]);
});

it("已保存的 webhook 按频道名展示，不再问环境变量", () => {
  const parsed = pushRoutesOf({
    routes: { "signal-4h": { discordDests: ["main", "mirror-4h"], discordWebhooks: ["https://discord.com/api/webhooks/1/main"], telegram: true } },
  });
  expect(presentDiscordHookRows(parsed.routes["signal-4h"])).toEqual([
    { label: "#常规", url: "https://discord.com/api/webhooks/1/main" },
  ]);
});

it("还没保存时按默认频道留空行", () => {
  expect(presentDiscordHookRows(defaultPushRoutes().routes["signal-4h"])).toEqual([
    { label: "#常规", url: "" },
    { label: "4H 镜像", url: "" },
  ]);
});

it("旧群 id 勾上该群全部话题，带 # 的只匹配该话题", () => {
  expect(expandTelegramChats(["-1", "-2#99"], ["-1#42", "-1#99", "-2#99", "-10#1"])).toEqual(["-1#42", "-1#99", "-2#99"]);
});
