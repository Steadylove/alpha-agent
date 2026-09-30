import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { postSignalImage } from "@/lib/notifications/postSignalImage";
import { defaultPushRoutes } from "@/lib/notifications/pushRoutesLogic";

const mocks = vi.hoisted(() => ({ discord: vi.fn(), telegram: vi.fn(), routes: vi.fn() }));
vi.mock("@/lib/discord/sendWebhook", () => ({ postDiscordImage: mocks.discord }));
vi.mock("@/lib/telegram/relay", () => ({ enqueueTelegramImage: mocks.telegram }));
vi.mock("@/lib/notifications/pushRoutes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/pushRoutes")>();
  return {
    ...actual,
    readPushRoutes: mocks.routes,
    discordWebhookOf: (dest: string, fallback = "") => {
      if (dest === "main") return fallback;
      if (dest === "mirror-4h") return process.env.DISCORD_MIRROR_4H_WEBHOOK_URL || "";
      return "";
    },
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.routes.mockResolvedValue(defaultPushRoutes());
  mocks.telegram.mockResolvedValue({ ok: true, recipients: 1 });
});
afterEach(() => vi.unstubAllEnvs());

const input = { kind: "option-flow" as const, filename: "signal.png", bytes: Buffer.from("image"), content: "signal", eventKey: "test-event", premiumUsd: 500_000 };

it.each([499_999, undefined, NaN, Infinity])("金额 %s 未达门槛或未确认时，两个平台都不发送", async (premiumUsd) => {
  await expect(postSignalImage("https://discord.com/api/webhooks/1/main", { ...input, premiumUsd })).resolves.toEqual({ skipped: true });
  expect(mocks.discord).not.toHaveBeenCalled();
  expect(mocks.telegram).not.toHaveBeenCalled();
});

it("每次读取网页门槛，并允许显式设为 0", async () => {
  const settings = defaultPushRoutes();
  settings.optionFlowMinPremiumUsd = 1_000_000;
  mocks.routes.mockResolvedValue(settings);
  expect(await postSignalImage("https://discord.com/api/webhooks/1/main", input)).toEqual({ skipped: true });
  settings.optionFlowMinPremiumUsd = 0;
  expect(await postSignalImage("https://discord.com/api/webhooks/1/main", { ...input, premiumUsd: undefined })).toEqual({ skipped: false });
  expect(mocks.telegram).toHaveBeenCalledTimes(1);
});

it("配置读取失败时不能降低门槛继续发送", async () => {
  mocks.routes.mockRejectedValue(new Error("settings unavailable"));
  await expect(postSignalImage("https://discord.com/api/webhooks/1/main", input)).rejects.toThrow("settings unavailable");
  expect(mocks.discord).not.toHaveBeenCalled();
  expect(mocks.telegram).not.toHaveBeenCalled();
});

it("两个平台使用同一张图和说明", async () => {
  await postSignalImage("https://discord.com/api/webhooks/1/main", input);
  expect(mocks.discord).toHaveBeenCalledWith("https://discord.com/api/webhooks/1/main", expect.objectContaining({ filename: "signal.png", content: "signal" }));
  expect(mocks.telegram).toHaveBeenCalledWith(expect.objectContaining({ filename: "signal.png" }), undefined);
});

it.each(["discord", "telegram"] as const)("%s 失败仍执行另一平台，同时明确报告失败", async (failed) => {
  mocks[failed].mockRejectedValue(new Error("unavailable"));
  await expect(postSignalImage("https://discord.com/api/webhooks/1/main", input)).rejects.toThrow("unavailable");
  expect(mocks.discord).toHaveBeenCalledTimes(1);
  expect(mocks.telegram).toHaveBeenCalledTimes(1);
});

it("关闭推送时两个平台都不发", async () => {
  const routes = defaultPushRoutes();
  routes.routes["option-flow"].enabled = false;
  mocks.routes.mockResolvedValue(routes);
  await expect(postSignalImage("https://discord.com/api/webhooks/1/main", input)).resolves.toEqual({ skipped: true });
  expect(mocks.discord).not.toHaveBeenCalled();
  expect(mocks.telegram).not.toHaveBeenCalled();
});

it("4H 买卖点默认再抄镜像频道", async () => {
  vi.stubEnv("DISCORD_MIRROR_4H_WEBHOOK_URL", "https://discord.com/api/webhooks/2/mirror");
  await postSignalImage("https://discord.com/api/webhooks/1/main", { ...input, kind: "signal-4h" });
  expect(mocks.discord).toHaveBeenCalledWith("https://discord.com/api/webhooks/1/main", expect.objectContaining({ filename: "signal.png" }));
  expect(mocks.discord).toHaveBeenCalledWith("https://discord.com/api/webhooks/2/mirror", expect.objectContaining({ filename: "signal.png" }));
  expect(mocks.telegram).toHaveBeenCalledTimes(1);
});

it("填了 webhook 就按地址发", async () => {
  const routes = defaultPushRoutes();
  routes.routes["option-flow"].discordWebhooks = ["https://discord.com/api/webhooks/1/custom"];
  mocks.routes.mockResolvedValue(routes);
  await postSignalImage("https://discord.com/api/webhooks/1/main", input);
  expect(mocks.discord).toHaveBeenCalledWith("https://discord.com/api/webhooks/1/custom", expect.objectContaining({ filename: "signal.png" }));
  expect(mocks.discord).not.toHaveBeenCalledWith("https://discord.com/api/webhooks/1/main", expect.anything());
});

it.each([{ discordWebhooks: [] }, { discordWebhooks: ["bad-webhook"] }])("Discord 地址 $discordWebhooks 不可用时仍发送 Telegram", async ({ discordWebhooks }) => {
  const routes = defaultPushRoutes();
  routes.routes["option-flow"].discordWebhooks = discordWebhooks;
  mocks.routes.mockResolvedValue(routes);
  await expect(postSignalImage("", input)).resolves.toEqual({ skipped: false });
  expect(mocks.discord).not.toHaveBeenCalled();
  expect(mocks.telegram).toHaveBeenCalledTimes(1);
});

it.each([{ discordWebhooks: [] }, { discordWebhooks: ["bad-webhook"] }])("Discord 地址 $discordWebhooks 不可用且没有 Telegram 时跳过", async ({ discordWebhooks }) => {
  const routes = defaultPushRoutes();
  routes.routes["option-flow"].discordWebhooks = discordWebhooks;
  routes.routes["option-flow"].telegram = false;
  mocks.routes.mockResolvedValue(routes);
  await expect(postSignalImage("", input)).resolves.toEqual({ skipped: true });
  expect(mocks.discord).not.toHaveBeenCalled();
  expect(mocks.telegram).not.toHaveBeenCalled();
});

it.each([{ skipped: true }, { ok: true, recipients: 0 }])("Telegram 返回 %j 且无 Discord 时按全部跳过处理", async (result) => {
  mocks.telegram.mockResolvedValue(result);
  await expect(postSignalImage("", input)).resolves.toEqual({ skipped: true });
});

it("Telegram 跳过时保留 Discord 的已发送结果", async () => {
  mocks.telegram.mockResolvedValue({ skipped: true });
  await expect(postSignalImage("https://discord.com/api/webhooks/1/main", input)).resolves.toEqual({ skipped: false });
  expect(mocks.discord).toHaveBeenCalledTimes(1);
});

it("Telegram 明确返回失败时仍尝试 Discord 并报告错误", async () => {
  mocks.telegram.mockResolvedValue({ ok: false });
  await expect(postSignalImage("https://discord.com/api/webhooks/1/main", input)).rejects.toThrow("Telegram");
  expect(mocks.discord).toHaveBeenCalledTimes(1);
});
