import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCboeVolIndexHistory } from "@/lib/data-sources/cboe";

afterEach(() => vi.unstubAllGlobals());
const csv = (day = "22", close = 14.21) => new Response(`DATE,OPEN,HIGH,LOW,CLOSE\n09/${day}/2026,14.64,15.50,14.00,${close}\n`);
const yahoo = (dates: string[], closes: (number | null)[]) => Response.json({ chart: { result: [{
  timestamp: dates.map((day) => Date.parse(`${day}T07:00:00Z`) / 1000),
  indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 0) }] },
}] } });

describe("波动率指数已收盘日补缺", () => {
  it("官方齐全时不请求备用源", async () => {
    const fetcher = vi.fn().mockResolvedValue(csv("23", 15.18));
    vi.stubGlobal("fetch", fetcher);
    const rows = await fetchCboeVolIndexHistory("VIX", { through: "2026-09-23" });
    expect(rows.at(-1)).toMatchObject({ date: "2026-09-23", source: "cboe", close: 15.18 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("HTTP 200 但官方滞后时补缺，保留官方同日值且排除未收盘日", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(csv()).mockResolvedValueOnce(yahoo(
      ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"], [null, 99, 15.18, 16],
    ));
    vi.stubGlobal("fetch", fetcher);
    const rows = await fetchCboeVolIndexHistory("VIX", { through: "2026-09-23" });
    expect(rows.map((r) => [r.date, r.close, r.source])).toEqual([
      ["2026-09-22", 14.21, "cboe"], ["2026-09-23", 15.18, "yahoo"],
    ]);
    expect(rows.at(-1)?.symbol).toBe("VIX");
    expect(new URL(fetcher.mock.calls[1][0]).pathname).toContain("%5EVIX");
  });

  it("官方请求失败时仍可补齐，备用源失败或无有效数据时不伪造目标日", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(yahoo(["2026-09-23"], [15.18]));
    vi.stubGlobal("fetch", fetcher);
    expect((await fetchCboeVolIndexHistory("VIX", { through: "2026-09-23" })).at(-1)?.source).toBe("yahoo");
    fetcher.mockResolvedValueOnce(csv()).mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    expect((await fetchCboeVolIndexHistory("VIX", { through: "2026-09-23" })).at(-1)?.date).toBe("2026-09-22");
    fetcher.mockResolvedValueOnce(csv()).mockResolvedValueOnce(yahoo(["2026-09-23"], [0]));
    expect((await fetchCboeVolIndexHistory("VIX", { through: "2026-09-23" })).at(-1)?.date).toBe("2026-09-22");
  });

  it("历史调用不传目标日时保持官方单一来源，两源均失败时抛错", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(csv());
    vi.stubGlobal("fetch", fetcher);
    expect((await fetchCboeVolIndexHistory("VIX")).at(-1)?.source).toBe("cboe");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(fetchCboeVolIndexHistory("VIX", { through: "2026-09-23" })).rejects.toThrow("CBOE/Yahoo");
  });
});
