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
      if (dest === "main") return fallback || "discord-hook";
      if (dest === "mirror-4h") return process.env.DISCORD_MIRROR_4H_WEBHOOK_URL || "";
      return "";
    },
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.routes.mockResolvedValue(defaultPushRoutes());
});
afterEach(() => vi.unstubAllEnvs());

const input = { kind: "option-flow" as const, filename: "signal.png", bytes: Buffer.from("image"), content: "signal", eventKey: "test-event" };

it("两个平台使用同一张图和说明", async () => {
  await postSignalImage("discord-hook", input);
  expect(mocks.discord).toHaveBeenCalledWith("discord-hook", expect.objectContaining({ filename: "signal.png", content: "signal" }));
  expect(mocks.telegram).toHaveBeenCalledWith(expect.objectContaining({ filename: "signal.png" }), undefined);
});

it.each(["discord", "telegram"] as const)("%s 失败仍执行另一平台，同时明确报告失败", async (failed) => {
  mocks[failed].mockRejectedValue(new Error("unavailable"));
  await expect(postSignalImage("discord-hook", input)).rejects.toThrow("unavailable");
  expect(mocks.discord).toHaveBeenCalledTimes(1);
  expect(mocks.telegram).toHaveBeenCalledTimes(1);
});

it("关闭推送时两个平台都不发", async () => {
  const routes = defaultPushRoutes();
  routes.routes["option-flow"].enabled = false;
  mocks.routes.mockResolvedValue(routes);
  await expect(postSignalImage("discord-hook", input)).resolves.toEqual({ skipped: true });
  expect(mocks.discord).not.toHaveBeenCalled();
  expect(mocks.telegram).not.toHaveBeenCalled();
});

it("4H 买卖点默认再抄镜像频道", async () => {
  vi.stubEnv("DISCORD_MIRROR_4H_WEBHOOK_URL", "https://discord.example/4h");
  await postSignalImage("discord-hook", { ...input, kind: "signal-4h" });
  expect(mocks.discord).toHaveBeenCalledWith("discord-hook", expect.objectContaining({ filename: "signal.png" }));
  expect(mocks.discord).toHaveBeenCalledWith("https://discord.example/4h", expect.objectContaining({ filename: "signal.png" }));
  expect(mocks.telegram).toHaveBeenCalledTimes(1);
});

it("填了 webhook 就按地址发", async () => {
  const routes = defaultPushRoutes();
  routes.routes["option-flow"].discordWebhooks = ["https://discord.com/api/webhooks/1/custom"];
  mocks.routes.mockResolvedValue(routes);
  await postSignalImage("discord-hook", input);
  expect(mocks.discord).toHaveBeenCalledWith("https://discord.com/api/webhooks/1/custom", expect.objectContaining({ filename: "signal.png" }));
  expect(mocks.discord).not.toHaveBeenCalledWith("discord-hook", expect.anything());
});

