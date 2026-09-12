import { afterEach, describe, expect, it, vi } from "vitest";
import { marketDataSymbol } from "@/lib/data-sources/marketSymbol";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import { fetchYahoo1HBars } from "@/lib/data-sources/yahooIntraday";
import { fetchStooqDailyBars } from "@/lib/data-sources/stooq";
import { fetchAlpaca30MBars, fetchAlpacaDailyBars } from "@/lib/data-sources/alpaca";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const yahooBody = {
  chart: { result: [{ timestamp: [Date.parse("2026-09-09T13:30:00Z") / 1000], indicators: {
    quote: [{ open: [100], high: [102], low: [99], close: [101], volume: [1000] }],
  } }] },
};

describe("行情代码变更", () => {
  it.each([["MMC", "MRSH"], ["PSTG", "P"]])("%s 日线与1H均请求 %s，返回日线仍保留账本代码", async (old, current) => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(yahooBody));
    vi.stubGlobal("fetch", fetcher);
    const daily = await fetchYahooDailyBars(old);
    const hourly = await fetchYahoo1HBars(old, Date.parse("2026-09-08T00:00:00Z") / 1000);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      `/v8/finance/chart/${current}`, `/v8/finance/chart/${current}`,
    ]);
    expect(daily[0]).toMatchObject({ symbol: old, close: 101 });
    expect(hourly[0].close).toBe(101);
  });

  it.each([["MMC", "MRSH"], ["PSTG", "P"]])("%s 的备用源与 Alpaca 同样解析为 %s，保持输出身份", async (old, current) => {
    vi.stubEnv("ALPACA_API_KEY", "test-key"); vi.stubEnv("ALPACA_API_SECRET", "test-secret");
    const fetcher = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = new URL(input);
      if (url.hostname === "stooq.com") return new Response("Date,Open,High,Low,Close,Volume\n2026-09-09,100,102,99,101,1000\n");
      return Response.json({ bars: [{ t: "2026-09-09T13:30:00Z", o: 100, h: 102, l: 99, c: 101, v: 1000 }] });
    });
    vi.stubGlobal("fetch", fetcher);
    const stooq = await fetchStooqDailyBars(old);
    const daily = await fetchAlpacaDailyBars(old, "2026-01-01T00:00:00Z");
    const hourly = await fetchAlpaca30MBars(old, "2026-01-01T00:00:00Z");
    const urls = fetcher.mock.calls.map(([url]) => new URL(url));
    expect(urls[0].searchParams.get("s")).toBe(`${current.toLowerCase()}.us`);
    expect(urls.slice(1).every((url) => url.pathname === `/v2/stocks/${current}/bars`)).toBe(true);
    expect(stooq[0].symbol).toBe(old); expect(daily[0].symbol).toBe(old);
    expect(hourly[0].close).toBe(101);
  });

  it.each([["BRK-B", "BRK.B"], ["BF-B", "BF.B"]])("Alpaca 把 %s 换成 %s，返回仍用账本代码", async (book, alpaca) => {
    vi.stubEnv("ALPACA_API_KEY", "test-key"); vi.stubEnv("ALPACA_API_SECRET", "test-secret");
    const fetcher = vi.fn().mockResolvedValue(Response.json({ bars: [{ t: "2026-09-09T13:30:00Z", o: 100, h: 102, l: 99, c: 101, v: 1000 }] }));
    vi.stubGlobal("fetch", fetcher);
    const daily = await fetchAlpacaDailyBars(book, "2026-01-01T00:00:00Z");
    expect(new URL(fetcher.mock.calls[0][0]).pathname).toBe(`/v2/stocks/${alpaca}/bars`);
    expect(daily[0].symbol).toBe(book);
  });

  it("普通股票、新代码和宏观代码保持不变，未知404仍向上抛错", async () => {
    for (const symbol of ["AAPL", "MRSH", "P", "DX-Y.NYB", "BRK-B"]) expect(marketDataSymbol(symbol)).toBe(symbol);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    await expect(fetchYahoo1HBars("UNKNOWN")).rejects.toThrow("HTTP 404");
    await expect(fetchYahooDailyBars("UNKNOWN")).rejects.toThrow("404");
  });

  it("1H缩短窗口重试仍使用新代码，修复不绕过数据源错误", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("range too long", { status: 422 }))
      .mockResolvedValueOnce(Response.json(yahooBody));
    vi.stubGlobal("fetch", fetcher);
    expect(await fetchYahoo1HBars("MMC")).toHaveLength(1);
    expect(fetcher.mock.calls.every(([url]) => new URL(url).pathname.endsWith("/MRSH"))).toBe(true);
  });
});
