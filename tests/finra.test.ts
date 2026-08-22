import { fetchLatestShortInterest } from "@/lib/data-sources/finra";
import { afterEach, describe, expect, it, vi } from "vitest";

type Row = {
  symbolCode: string;
  settlementDate: string;
  currentShortPositionQuantity: string;
};

/** 按调用次序依次返回各页，模拟 FINRA 的 offset 翻页。 */
function mockFinra(pages: Row[][]) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const page = pages[call] ?? [];
    call += 1;
    return { ok: true, json: async () => page } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLatestShortInterest", () => {
  it("同一标的有多期时只保留结算日最新的一期", async () => {
    mockFinra([
      [
        { symbolCode: "NVDA", settlementDate: "2026-06-30", currentShortPositionQuantity: "100" },
        { symbolCode: "NVDA", settlementDate: "2026-07-31", currentShortPositionQuantity: "300" },
        { symbolCode: "NVDA", settlementDate: "2026-07-15", currentShortPositionQuantity: "200" },
      ],
    ]);

    const out = await fetchLatestShortInterest(["NVDA"]);
    expect(out.get("NVDA")).toEqual({
      symbol: "NVDA",
      settlementDate: "2026-07-31",
      sharesShort: 300,
    });
  });

  it("跨页也能选出最新一期，不受分页边界影响", async () => {
    const filler = Array.from({ length: 5000 }, (_, i) => ({
      symbolCode: `X${i}`,
      settlementDate: "2026-07-31",
      currentShortPositionQuantity: "1",
    }));
    filler[0] = {
      symbolCode: "NVDA",
      settlementDate: "2026-07-15",
      currentShortPositionQuantity: "200",
    };

    mockFinra([
      filler,
      [{ symbolCode: "NVDA", settlementDate: "2026-07-31", currentShortPositionQuantity: "300" }],
    ]);

    const out = await fetchLatestShortInterest(["NVDA"]);
    expect(out.get("NVDA")!.sharesShort).toBe(300);
  });

  it("只返回请求的标的，忽略全市场其余两万只", async () => {
    mockFinra([
      [
        { symbolCode: "NVDA", settlementDate: "2026-07-31", currentShortPositionQuantity: "300" },
        { symbolCode: "GME", settlementDate: "2026-07-31", currentShortPositionQuantity: "999" },
      ],
    ]);

    const out = await fetchLatestShortInterest(["NVDA"]);
    expect([...out.keys()]).toEqual(["NVDA"]);
  });

  it("字段缺失或非数值的行直接跳过，不污染结果", async () => {
    mockFinra([
      [
        { symbolCode: "NVDA", settlementDate: "2026-07-31", currentShortPositionQuantity: "n/a" },
        { symbolCode: "NVDA", settlementDate: "2026-07-15", currentShortPositionQuantity: "200" },
      ],
    ]);

    const out = await fetchLatestShortInterest(["NVDA"]);
    expect(out.get("NVDA")!.sharesShort).toBe(200);
  });

  it("窗口内无记录时返回空表，而不是抛错", async () => {
    mockFinra([[]]);
    expect((await fetchLatestShortInterest(["NVDA"])).size).toBe(0);
  });

  it("接口报错时抛出，让任务记 FAILED 而非静默写入空数据", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, text: async () => "down" }) as unknown as Response),
    );
    await expect(fetchLatestShortInterest(["NVDA"])).rejects.toThrow("FINRA 503");
  });
});
