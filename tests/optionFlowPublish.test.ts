import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { publishOptionFlow } from "@/lib/optionFlow/publish";
import type { OptionFlowPost } from "@/lib/optionFlow/types";

const mocks = vi.hoisted(() => ({ discord: vi.fn(), bot: vi.fn(), telegram: vi.fn() }));

vi.mock("@/lib/discord/sendWebhook", () => ({
  postDiscordImage: mocks.discord,
  postDiscordBotImage: mocks.bot,
}));
vi.mock("@/lib/telegram/relay", () => ({ enqueueTelegramImage: mocks.telegram }));
vi.mock("@/lib/optionFlow/cardImage", () => ({
  renderSingleFlowPng: vi.fn(async () => Buffer.from("png")),
  renderNoteworthyPng: vi.fn(async () => Buffer.from("png")),
  renderGexFlowPng: vi.fn(async () => Buffer.from("png")),
}));

function post(partial: Partial<OptionFlowPost> & Pick<OptionFlowPost, "id" | "kind">): OptionFlowPost {
  return {
    postedAt: "2026-09-13T00:00:00Z",
    ingestedAt: "",
    thesis: "",
    legs: [{ ticker: "NVDA" }],
    imageUrls: [],
    imageProxyUrls: [],
    rawText: "",
    ...partial,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DISCORD_SIGNAL_WEBHOOK_URL", "https://discord.example/hook");
});
afterEach(() => vi.unstubAllEnvs());

it("单笔同时推 Discord 和 Telegram，用 tweet 去重", async () => {
  await publishOptionFlow(post({ id: "m1", kind: "flow", tweetId: "t1" }));
  const image = { filename: "option-flow.png", bytes: Buffer.from("png"), content: "期权流 · 单笔" };
  expect(mocks.discord).toHaveBeenCalledWith("https://discord.example/hook", image);
  expect(mocks.telegram).toHaveBeenCalledWith({ ...image, eventKey: "option-flow:t1" });
  expect(mocks.bot).not.toHaveBeenCalled();
});

it("确认名单仍只走 Discord", async () => {
  await publishOptionFlow(post({ id: "m2", kind: "noteworthy" }));
  expect(mocks.discord).toHaveBeenCalledTimes(1);
  expect(mocks.telegram).not.toHaveBeenCalled();
});

it("Telegram 入队失败不挡 Discord，避免工人重发", async () => {
  mocks.telegram.mockRejectedValue(new Error("Telegram 推送服务未配置"));
  await expect(publishOptionFlow(post({ id: "m3", kind: "flow", tweetId: "t3" }))).resolves.toBeUndefined();
  expect(mocks.discord).toHaveBeenCalledTimes(1);
});
