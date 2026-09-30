import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn(), renderGex: vi.fn(), renderDigest: vi.fn(), fetch: vi.fn() }));
vi.mock("../scripts/load-env", () => ({}));
vi.mock("node:fs", () => ({ existsSync: () => false, readFileSync: () => JSON.stringify({ items: [{}] }) }));
vi.mock("@/lib/discord/gexBriefCardOg", () => ({ renderGexBriefOgPng: mocks.renderGex }));
vi.mock("@/lib/discord/marketStateCopy", () => ({ gexBriefPushBody: () => ({ filename: "gex.png", content: "gex", input: { gex: { asOf: "2026-09-29" } } }) }));
vi.mock("@/lib/notifications/postSignalImage", () => ({ postSignalImage: mocks.post }));
vi.mock("@/lib/optionFlow/cardImage", () => ({ renderDailyDigestPng: mocks.renderDigest }));
vi.mock("@/lib/optionFlow/digest", () => ({ buildDailyFlowDigest: () => ({ day: "2026-09-29", legs: [], spy: {}, notes: [] }), flowDigestCaption: () => "digest", hasDigestContent: () => true }));
vi.mock("@/lib/optionFlow/store", () => ({ readOptionFlow: async () => ({ posts: [] }), optionFlowOf: (value: unknown) => value }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("MARKET_DATA_BASE_URL", "");
  vi.stubEnv("GEX_LOCAL", "1");
  vi.stubGlobal("fetch", mocks.fetch);
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.post.mockResolvedValue({ skipped: false });
  mocks.renderGex.mockResolvedValue(Buffer.from("gex"));
  mocks.renderDigest.mockResolvedValue(Buffer.from("digest"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(["render", "post"])("本地 GEX %s 失败仍投递期权流日结，最终失败且不重试", async (step) => {
  if (step === "render") mocks.renderGex.mockRejectedValueOnce(new Error("gex failed"));
  else mocks.post.mockRejectedValueOnce(new Error("gex failed"));
  await import("../scripts/push-gex-card");
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(mocks.renderDigest).toHaveBeenCalledTimes(1);
  expect(mocks.post).toHaveBeenCalledTimes(step === "render" ? 1 : 2);
  expect(mocks.post.mock.lastCall?.[1].kind).toBe("option-flow-digest");
  expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("gex failed") }));
});

it("远程 GEX 失败仍投递日结，两个错误都报告", async () => {
  vi.stubEnv("GEX_LOCAL", "0");
  mocks.fetch.mockResolvedValueOnce(new Response("gex failed", { status: 500 }))
    .mockResolvedValueOnce(new Response("digest failed", { status: 500 }));
  await import("../scripts/push-gex-card");
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(String(mocks.fetch.mock.lastCall?.[0])).toContain("render-option-flow-digest");
  expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/gex failed.*digest failed/) }));
});

it("日结失败不能记为成功", async () => {
  mocks.post.mockResolvedValueOnce({ skipped: false }).mockRejectedValueOnce(new Error("digest failed"));
  await import("../scripts/push-gex-card");
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("digest failed") }));
});

it.each(["local", "remote"])("%s GEX 与日结跳过时不报告已发送", async (mode) => {
  vi.stubEnv("GEX_LOCAL", mode === "local" ? "1" : "0");
  mocks.post.mockResolvedValue({ skipped: true });
  mocks.fetch.mockImplementation(async () => Response.json({ ok: true, skipped: true }));
  await import("../scripts/push-gex-card");
  await vi.waitFor(() => expect(console.log).toHaveBeenCalledTimes(2));
  expect(vi.mocked(console.log).mock.calls.every(call => String(call[0]).startsWith("skip"))).toBe(true);
  expect(process.exit).not.toHaveBeenCalled();
});
