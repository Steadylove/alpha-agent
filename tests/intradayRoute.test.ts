import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST, GET } from "@/app/api/tv/intraday/route";
import { RelayHttpError } from "@/lib/telegram/relay";
const mocks = vi.hoisted(() => ({ ingest: vi.fn(), journal: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/telegram/relay", () => ({
  relayIntradaySignal: mocks.ingest, readIntradayJournal: mocks.journal,
  RelayHttpError: class extends Error { constructor(public status: number) { super("private upstream detail"); } },
}));
vi.mock("@/lib/runtimeConfig", () => ({ loadRuntimeConfig: mocks.load }));
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("CRON_SECRET", "admin-test"); });
afterEach(() => { vi.unstubAllEnvs(); });
const secret = "a".repeat(64);
const p = { protocol: "intraday-v1", strategy: "resonance-long", scriptVersion: "1.0.0", strategyKey: "default", symbol: "NASDAQ:TEST", tf: "1",
  event: "entry", reason: "premium_resonance", barTime: 1790596800000, signalTime: 1790596860000, entrySignalTime: 1790596860000,
  price: 3.5, entryPrice: 3.5, stop: 3.2, metrics: { premium: true }, parameters: { buyCooldown: 4 } };
const request = (body: string, key = secret) => new Request(`https://site.test/api/tv/intraday?key=${key}`, { method: "POST", body });

it("无接收凭据/畸形/超大正文均不进入队列", async () => {
  expect((await POST(request(JSON.stringify(p), ""))).status).toBe(401);
  expect((await POST(request("not-json"))).status).toBe(400);
  expect((await POST(request(JSON.stringify({ ...p, tf: "240" })))).status).toBe(400);
  expect((await POST(request("x".repeat(17000)))).status).toBe(413);
  expect(mocks.ingest).not.toHaveBeenCalled();
});
it("等待持久化确认；失败不假报成功，也不泄露密钥或上游正文", async () => {
  mocks.ingest.mockResolvedValue({ ok: true, recorded: true, id: "signal", duplicate: false });
  const res = await POST(request(JSON.stringify(p)));
  expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ recorded: true });
  expect(mocks.ingest).toHaveBeenCalledWith(JSON.stringify(p), secret);
  mocks.ingest.mockRejectedValue(new Error(`upstream secret=${secret}`));
  const error = await POST(request(JSON.stringify(p)));
  expect(error.status).toBe(503); expect(await error.text()).not.toContain(secret);
  mocks.ingest.mockRejectedValue(new RelayHttpError(401));
  expect((await POST(request(JSON.stringify(p)))).status).toBe(401);
});
it("复盘档案仅管理员可读；日期校验后才访问 VPS", async () => {
  expect((await GET(new Request("https://site.test/api/tv/intraday?date=2026-09-28"))).status).toBe(401);
  const headers = { authorization: "Bearer admin-test" };
  expect((await GET(new Request("https://site.test/api/tv/intraday?date=../../x", { headers }))).status).toBe(400);
  expect(mocks.journal).not.toHaveBeenCalled();
  mocks.journal.mockResolvedValue({ ok: true, date: "2026-09-28", records: [] });
  const response = await GET(new Request("https://site.test/api/tv/intraday?date=2026-09-28", { headers }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.journal).toHaveBeenCalledWith("2026-09-28");
});
it("CSV 包含参数和指标快照；避免文本被表格软件解释为公式", async () => {
  mocks.journal.mockResolvedValue({ ok: true, date: "2026-09-28", records: [{ id: "a", date: "2026-09-28", receivedAt: p.signalTime,
    payload: { ...p, strategyKey: "=malicious()" }, disposition: "accepted", state: "pending", deliveries: [], telegramDeliveries: [] }] });
  const response = await GET(new Request("https://site.test/api/tv/intraday?date=2026-09-28&format=csv", { headers: { authorization: "Bearer admin-test" } }));
  expect(response.headers.get("content-type")).toContain("text/csv");
  const text = await response.text();
  expect(text).toContain("parameters_json"); expect(text).toContain('"\'=malicious()"'); expect(text).toContain("premium");
});
