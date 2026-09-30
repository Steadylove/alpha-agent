import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sendAlphaScreenerToDiscord } from "@/lib/discord/screenerWebhook";
import { defaultPushRoutes } from "@/lib/notifications/pushRoutesLogic";
import type { ScreenerResult } from "@/lib/jobs/alphaScreener";

const mocks = vi.hoisted(() => ({ request: vi.fn(), routes: vi.fn(), telegram: vi.fn() }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("@/lib/discord/screenerCardImage", () => ({ renderScreenerCardPng: vi.fn(async () => Buffer.from("png")) }));
vi.mock("@/lib/telegram/relay", () => ({ enqueueTelegramImage: mocks.telegram }));
vi.mock("@/lib/notifications/pushRoutes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/notifications/pushRoutes")>(), readPushRoutes: mocks.routes,
}));

const first = "https://discord.com/api/webhooks/1/first";
const second = "https://discord.com/api/webhooks/2/second";
const result: ScreenerResult = {
  generatedAt: new Date("2026-09-22T21:00:00Z"), universeSize: 1, rankedSize: 1, baseThreshold: 90,
  elite: [], newHighs: [], dailyFetchErrors: 0,
};
const withAnalysis: ScreenerResult = { ...result, elite: [{ symbol: "AAPL", name: "Apple", sector: null, industry: null, industryLabel: "", blurb: "", rps: { 20: 99, 50: 99, 120: 99, 250: 99 }, rpsAvg: 99, minRps: 99, alphaAnalysis: "analysis" }] };

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("DISCORD_WEBHOOK_URL", ""); vi.stubEnv("DISCORD_SIGNAL_WEBHOOK_URL", "");
  const routes = defaultPushRoutes();
  routes.routes.screener = { ...routes.routes.screener, discordWebhooks: [first, second], telegram: true, telegramAll: true };
  mocks.routes.mockResolvedValue(routes);
  mocks.telegram.mockResolvedValue({ ok: true, recipients: 1 });
  mocks.request.mockImplementation((_options, callback) => {
    const req = new EventEmitter();
    Object.assign(req, { write: vi.fn(), end: () => callback({ statusCode: 204 }) });
    return req;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

async function settle(promise: Promise<void>) {
  const outcome = promise.then(() => undefined, (error: unknown) => error);
  await vi.runAllTimersAsync();
  return outcome;
}

it("一个 Discord 失败仍发送其他 Discord 和两张 Telegram 图，最后报告失败", async () => {
  mocks.request.mockImplementation((options, callback) => {
    const req = new EventEmitter();
    Object.assign(req, { write: vi.fn(), end: () => options.path.endsWith("/first") ? req.emit("error", new Error("first unavailable")) : callback({ statusCode: 204 }) });
    return req;
  });
  expect(await settle(sendAlphaScreenerToDiscord(first, result))).toBeInstanceOf(Error);
  expect(mocks.request.mock.calls.filter(([options]) => options.path.endsWith("/first"))).toHaveLength(3);
  expect(mocks.request.mock.calls.some(([options]) => options.path.endsWith("/second"))).toBe(true);
  expect(mocks.telegram).toHaveBeenCalledTimes(2);
});

it("第一张 Telegram 失败仍尝试第二张，并保留错误", async () => {
  mocks.telegram.mockRejectedValueOnce(new Error("telegram unavailable"));
  expect(await settle(sendAlphaScreenerToDiscord(first, result))).toMatchObject({ message: expect.stringContaining("telegram unavailable") });
  expect(mocks.telegram).toHaveBeenCalledTimes(2);
});

it("显式坏地址全部跳过，仍发送 Telegram，AI 不能退回原 webhook", async () => {
  const routes = defaultPushRoutes();
  routes.routes.screener = { ...routes.routes.screener, discordWebhooks: ["not-a-webhook"], telegram: true, telegramAll: true };
  mocks.routes.mockResolvedValue(routes);
  expect(await settle(sendAlphaScreenerToDiscord(first, withAnalysis))).toBeUndefined();
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.telegram).toHaveBeenCalledTimes(2);
});

it("Telegram 失败仍发送已校验目标的 AI 分析", async () => {
  mocks.telegram.mockRejectedValue(new Error("telegram unavailable"));
  expect(await settle(sendAlphaScreenerToDiscord(first, withAnalysis))).toMatchObject({ message: expect.stringContaining("telegram unavailable") });
  const analysisCalls = mocks.request.mock.calls.filter(([options]) => options.headers["content-type"] === "application/json");
  expect(analysisCalls).toHaveLength(1);
  expect(analysisCalls[0][0].path).toBe("/api/webhooks/1/first");
});

it.each([{ skipped: true }, { ok: false }, { ok: true, recipients: 0 }])("Telegram 回执 %j 不能记作成功", async (receipt) => {
  mocks.telegram.mockResolvedValue(receipt);
  expect(await settle(sendAlphaScreenerToDiscord(first, result))).toBeInstanceOf(Error);
  expect(mocks.telegram).toHaveBeenCalledTimes(2);
});

it.each([
  ["image", "AbortError"], ["analysis", "AbortError"],
  ["image", "TimeoutError"], ["analysis", "TimeoutError"],
])("Discord %s 遇到 %s 不自动重发，其他推送仍完成", async (kind, errorName) => {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    expect(delay).toBeLessThanOrEqual(30_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), delay);
    return controller.signal;
  });
  const stalled: Array<{ signal?: AbortSignal }> = [];
  mocks.request.mockImplementation((options, callback) => {
    const req = new EventEmitter();
    const isAnalysis = options.headers["content-type"] === "application/json";
    const shouldStall = options.path.endsWith("/first") && isAnalysis === (kind === "analysis");
    Object.assign(req, { write: vi.fn(), end: () => {
      if (!shouldStall) { callback({ statusCode: 204 }); return; }
      stalled.push(options);
      options.signal?.addEventListener("abort", () => req.emit("error", Object.assign(new Error("request timed out"), { name: errorName })), { once: true });
    } });
    return req;
  });
  const outcome = sendAlphaScreenerToDiscord(first, kind === "analysis" ? withAnalysis : result).then(() => undefined, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(stalled[0]?.signal).toBeInstanceOf(AbortSignal);
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ message: expect.stringContaining("request timed out") });
  expect(stalled).toHaveLength(1);
  expect(mocks.request.mock.calls.some(([options]) => options.path.endsWith("/second"))).toBe(true);
  expect(mocks.telegram).toHaveBeenCalledTimes(2);
});
