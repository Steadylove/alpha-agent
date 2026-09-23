import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { publishOptionFlow } from "@/lib/optionFlow/publish";
import type { OptionFlowPost } from "@/lib/optionFlow/types";

const mocks = vi.hoisted(() => ({ discord: vi.fn(), bot: vi.fn(), fetch: vi.fn() }));

vi.mock("@/lib/discord/sendWebhook", () => ({
  postDiscordImage: mocks.discord,
  postDiscordBotImage: mocks.bot,
}));
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
    legs: [{ ticker: "NVDA", premiumUsd: 600_000 }],
    imageUrls: [],
    imageProxyUrls: [],
    rawText: "",
    ...partial,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DISCORD_SIGNAL_WEBHOOK_URL", "https://discord.example/hook");
  vi.stubEnv("OPTION_FLOW_PUSH_URL", "https://app.test/api/tv/render-option-flow");
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllEnvs());

it("单笔交给网站 postSignalImage 入口，和买卖卡同一条路径", async () => {
  await publishOptionFlow(post({ id: "m1", kind: "flow", tweetId: "t1" }));
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://app.test/api/tv/render-option-flow");
  expect(JSON.parse(String(init.body))).toEqual({
    filename: "option-flow.png",
    content: "期权流 · 单笔",
    eventKey: "option-flow:t1",
    png: Buffer.from("png").toString("base64"),
    premiumUsd: 600_000,
  });
  expect(mocks.discord).not.toHaveBeenCalled();
  expect(mocks.bot).not.toHaveBeenCalled();
});

it("接收端因网页门槛跳过时返回未发送状态", async () => {
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, skipped: true }), { status: 200 }));
  expect(await publishOptionFlow(post({ id: "skip", kind: "flow" }))).toEqual({ skipped: true });
});

it("确认名单默认走 Discord 配置通道，不改网站单笔入口", async () => {
  await publishOptionFlow(post({ id: "m2", kind: "noteworthy" }));
  expect(mocks.discord).toHaveBeenCalledTimes(1);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
