import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/signal-pool/route";
import { readSignalPool, writeSignalPool } from "@/lib/fund/signalPool";

vi.mock("@/lib/fund/signalPool", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/fund/signalPool")>(),
  defaultSignalPoolTickers: () => ["AAPL", "NVDA"],
  readSignalPool: vi.fn(),
  writeSignalPool: vi.fn(),
}));

beforeEach(() => vi.resetAllMocks());

describe("记账池接口的一致性", () => {
  it("GET 的名单和增删信息来自同一次读取", async () => {
    vi.mocked(readSignalPool).mockResolvedValue({ members: ["NVDA"], added: [], removed: ["AAPL"], updatedAt: "2026-09-09T00:00:00Z" });
    const response = await GET();
    expect(await response.json()).toMatchObject({ members: ["NVDA"], removed: ["AAPL"] });
    expect(readSignalPool).toHaveBeenCalledTimes(1);
  });

  it("保存成功后直接返回本次保存值，后续读取失败不会误报保存失败", async () => {
    vi.mocked(readSignalPool).mockRejectedValue(new Error("VPS read failed"));
    vi.mocked(writeSignalPool).mockImplementation(async (patch) => ({ ...patch, updatedAt: "2026-09-09T00:00:00Z" }));
    const response = await POST(new Request("http://localhost/api/signal-pool", {
      method: "POST", body: JSON.stringify({ action: "replace", members: ["NVDA"] }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, members: ["NVDA"], removed: ["AAPL"] });
    expect(readSignalPool).not.toHaveBeenCalled();
  });

  it("写入失败不会返回成功", async () => {
    vi.mocked(writeSignalPool).mockRejectedValue(new Error("VPS write failed"));
    const response = await POST(new Request("http://localhost/api/signal-pool", {
      method: "POST", body: JSON.stringify({ action: "replace", members: ["NVDA"] }),
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "VPS write failed" });
  });
});
