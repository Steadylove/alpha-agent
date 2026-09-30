import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "@/app/api/jobs/push-signal-book/route";

const mocks = vi.hoisted(() => ({ build: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/runtimeConfig", () => ({ loadRuntimeConfig: async () => {} }));
vi.mock("@/lib/fund/pushSignalBook", () => ({ buildSignalBooks: mocks.build }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.build.mockResolvedValue([
    { filename: "book-4h.png", summary: "现金账本1" },
    { filename: "book-2h.png", summary: "现金账本2" },
  ]);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(["http", "network"])("第一个账本 %s 失败仍出第二张图，保留失败状态且不重发", async (failure) => {
  if (failure === "http") mocks.fetch.mockResolvedValueOnce(new Response("first failed", { status: 500 }));
  else mocks.fetch.mockRejectedValueOnce(new Error("first failed"));
  mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true }));
  const pending = POST(new Request("https://alpha.example/api/jobs/push-signal-book", { method: "POST" }));
  await vi.runAllTimersAsync();
  const response = await pending;
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("first failed"), sent: ["现金账本2"] });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).filename).toBe("book-2h.png");
});

it("两个账本失败时汇总两个错误", async () => {
  mocks.fetch.mockResolvedValueOnce(new Response("first failed", { status: 500 }))
    .mockResolvedValueOnce(new Response("second failed", { status: 500 }));
  const pending = POST(new Request("https://alpha.example/api/jobs/push-signal-book", { method: "POST" }));
  await vi.runAllTimersAsync();
  const response = await pending;
  expect(response.status).toBe(500);
  expect((await response.json()).error).toMatch(/first failed.*second failed/);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});

it("出图接口报告 skipped 时不计为已发送", async () => {
  mocks.fetch.mockResolvedValueOnce(Response.json({ ok: true, skipped: true }))
    .mockResolvedValueOnce(Response.json({ ok: true, skipped: false }));
  const pending = POST(new Request("https://alpha.example/api/jobs/push-signal-book", { method: "POST" }));
  await vi.runAllTimersAsync();
  expect(await (await pending).json()).toEqual({ ok: true, sent: ["现金账本2"] });
});

it("首张请求60秒超时后仍投递第二张且不重试第一张", async () => {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("render timeout", "TimeoutError")), ms);
    return controller.signal;
  });
  mocks.fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal.reason));
  })).mockResolvedValueOnce(Response.json({ ok: true, skipped: false }));
  const pending = POST(new Request("https://alpha.example/api/jobs/push-signal-book", { method: "POST" }));
  await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  expect(AbortSignal.timeout).toHaveBeenCalledWith(60_000);
  await vi.runAllTimersAsync();
  expect((await pending).status).toBe(500);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
