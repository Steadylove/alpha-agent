import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultPushRoutes } from "@/lib/notifications/pushRoutesLogic";

const mocks = vi.hoisted(() => ({ routes: vi.fn(), discord: vi.fn(), telegram: vi.fn(), validate: vi.fn() }));
vi.mock("../scripts/load-env", () => ({}));
vi.mock("sharp", () => ({ default: () => ({ png: () => ({ toBuffer: async () => Buffer.from("png") }) }) }));
vi.mock("@/lib/review/health", () => ({ expectedReviewSession: () => ({ date: "2026-09-22", next: "2026-09-23" }) }));
vi.mock("@/lib/review/cardInputs", () => ({ validateReviewCards: mocks.validate, parseReviewBars: () => [] }));
vi.mock("@/lib/discord/tomorrowMapCardImage", () => ({ tomorrowMapCardSvg: () => "<svg/>" }));
vi.mock("@/lib/discord/optionsMapCardImage", () => ({ optionsMapCardSvg: () => "<svg/>" }));
vi.mock("@/lib/telegram/relay", () => ({ enqueueTelegramImage: mocks.telegram }));
vi.mock("@/lib/notifications/pushRoutes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/notifications/pushRoutes")>(), readPushRoutes: mocks.routes,
}));
vi.mock("@/lib/notifications/reviewCardDelivery", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/notifications/reviewCardDelivery")>(), postReviewDiscordImage: mocks.discord,
}));

let dir: string;
let originalExitCode: typeof process.exitCode;
const hook = "https://discord.com/api/webhooks/1/valid";
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  originalExitCode = process.exitCode;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  dir = mkdtempSync(path.join(tmpdir(), "review-card-push-"));
  const put = (file: string, content: string) => { const target = path.join(dir, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content); };
  put("rps/rps-latest.json", "{}"); put("snapshots/daily-review/index.json", '{"latest":"2026-09-22"}');
  put("snapshots/daily-review/2026-09-22.json", '{"date":"2026-09-22"}');
  put("1d/SPX.csv", ""); put("snapshots/gex-profiles/2026-09-22/SPX.json", "{}"); put("assets/trendAdaptiveLogo.svg", "<svg/>");
  vi.stubEnv("MARKET_DATA_DIR", dir); vi.stubEnv("MARKET_DATA_BASE_URL", ""); vi.stubEnv("REVIEW_CARD_ASSET_DIR", path.join(dir, "assets"));
  vi.stubEnv("REVIEW_CARD_STATE_DIR", path.join(dir, "state")); vi.stubEnv("REVIEW_CARD_TELEGRAM_CONFIG", "");
  vi.stubEnv("TELEGRAM_RELAY_URL", "https://relay.example"); vi.stubEnv("TELEGRAM_RELAY_SECRET", "test");
  const routes = defaultPushRoutes();
  routes.routes.gex = { ...routes.routes.gex, discordWebhooks: [hook], telegram: true, telegramAll: true };
  mocks.routes.mockResolvedValue(routes); mocks.discord.mockResolvedValue("message-id"); mocks.telegram.mockResolvedValue({ ok: true, recipients: 1 });
});
afterEach(() => {
  process.exitCode = originalExitCode;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

const receipts = () => Object.values(JSON.parse(readFileSync(path.join(dir, "state/2026-09-22.json"), "utf8")).receipts) as Array<{ status: string }>;
async function run() {
  await import("../scripts/push-review-cards");
  await vi.waitFor(() => {
    const calls = vi.mocked(console.log).mock.calls;
    expect(vi.mocked(console.error).mock.calls.length > 0 || calls.some(([label]) => label === "options-market-map Telegram:")).toBe(true);
  });
}

it("显式无效 Discord 地址不阻塞 Telegram，也不回退默认频道", async () => {
  const routes = defaultPushRoutes();
  routes.routes.gex = { ...routes.routes.gex, discordWebhooks: ["bad-webhook"], telegram: true, telegramAll: true };
  mocks.routes.mockResolvedValue(routes);
  await run();
  expect(mocks.discord).not.toHaveBeenCalled();
  expect(mocks.telegram).toHaveBeenCalledTimes(2);
  expect(receipts().map(r => r.status)).toEqual(["sent", "sent"]);
});

it("Telegram 缺少鉴权只记该通道失败，Discord 成功回执保留且再次运行不重发", async () => {
  vi.stubEnv("TELEGRAM_RELAY_SECRET", "");
  await run();
  expect(mocks.discord).toHaveBeenCalledTimes(2);
  expect(mocks.telegram).not.toHaveBeenCalled();
  expect(receipts().filter(r => r.status === "sent")).toHaveLength(2);
  expect(receipts().filter(r => r.status === "failed")).toHaveLength(2);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Telegram"));
  vi.mocked(console.error).mockClear(); vi.mocked(console.log).mockClear(); vi.resetModules();
  await run();
  expect(mocks.discord).toHaveBeenCalledTimes(2);
});

it("Telegram 没有收件人不写成功回执，仍保留 Discord 成功状态", async () => {
  mocks.telegram.mockResolvedValue({ ok: true, recipients: 0 });
  await run();
  expect(mocks.discord).toHaveBeenCalledTimes(2);
  expect(receipts().filter(r => r.status === "sent")).toHaveLength(2);
  expect(receipts().filter(r => r.status === "failed")).toHaveLength(2);
});

it("混合坏地址和发送失败时继续有效 Discord 与 Telegram，不重发不确定的 Discord", async () => {
  const failing = "https://discord.com/api/webhooks/2/failing";
  const routes = defaultPushRoutes();
  routes.routes.gex = { ...routes.routes.gex, discordWebhooks: ["bad-webhook", failing, hook], telegram: true, telegramAll: true };
  mocks.routes.mockResolvedValue(routes);
  mocks.discord.mockImplementation(async (url) => { if (url === failing) throw new Error("network response uncertain"); return "message-id"; });
  await run();
  expect(mocks.discord).toHaveBeenCalledTimes(4);
  expect(mocks.discord.mock.calls.every(([url]) => url === failing || url === hook)).toBe(true);
  expect(mocks.telegram).toHaveBeenCalledTimes(2);
  expect(receipts().filter(r => r.status === "sent")).toHaveLength(4);
  expect(receipts().filter(r => r.status === "uncertain")).toHaveLength(2);
  vi.mocked(console.error).mockClear(); vi.mocked(console.log).mockClear(); vi.resetModules();
  await run();
  expect(mocks.discord).toHaveBeenCalledTimes(4);
  expect(mocks.telegram).toHaveBeenCalledTimes(2);
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining("待核验"));
});

it("复盘数据前置校验失败仍阻止所有发送", async () => {
  mocks.validate.mockImplementation(() => { throw new Error("数据不完整"); });
  await run();
  expect(mocks.discord).not.toHaveBeenCalled(); expect(mocks.telegram).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith("数据不完整");
});
