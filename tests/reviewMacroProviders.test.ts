import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  fetchAlpacaBtc,
  freshestMacroValues,
  parseTreasuryXml,
} from "@/lib/data-sources/reviewMacroProviders";
import { refreshReviewMacro } from "@/lib/data-sources/reviewMacro";
import {
  macroEnvironment,
  mergeObservations,
  type MacroArchive,
} from "@/lib/review/macro";

const deps = vi.hoisted(() => ({
  fetch: vi.fn(),
  write: vi.fn(),
  yahoo: vi.fn(),
  old: null as MacroArchive | null,
}));
vi.mock("@/lib/data-sources/alpaca", () => ({
  alpacaCredentials: () => ({ key: "test-key", secret: "test-secret" }),
}));
vi.mock("@/lib/vps/snapshot", () => ({
  readSnapshot: async () => deps.old,
  writeSnapshot: (...args: unknown[]) => deps.write(...args),
}));
vi.mock("@/lib/data-sources/yahoo", () => ({
  fetchYahooDailyBars: (...args: unknown[]) => deps.yahoo(...args),
}));
const now = "2026-09-23T05:00:00.000Z";
const days = ["2026-09-21", "2026-09-22"];
const xml = (rows: string) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices">${rows}</feed>`;
const entry = (date: string, fields: string) =>
  `<entry><content><m:properties><d:NEW_DATE>${date}T00:00:00</d:NEW_DATE>${fields}</m:properties></content></entry>`;
const rates = xml(
  days
    .map((d) =>
      entry(
        d,
        `<d:BC_2YEAR>4.71</d:BC_2YEAR><d:BC_10YEAR>4.96</d:BC_10YEAR><d:TC_10YEAR>2.63</d:TC_10YEAR>`,
      ),
    )
    .join(""),
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal("fetch", deps.fetch);
  deps.fetch.mockReset();
  deps.write.mockClear();
  deps.yahoo.mockReset();
  deps.old = null;
  deps.yahoo.mockResolvedValue(days.map((date) => ({ date, close: 100 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("财政部 XML 保留负利率，忽略空值、null 和非法日期", () => {
  const document = xml(
    entry(days[0], '<d:BC_10YEAR m:type="Edm.Double">-0.5</d:BC_10YEAR>') +
      entry(days[1], '<d:BC_10YEAR m:null="true">0</d:BC_10YEAR>') +
      entry("2026-09-23", "<d:BC_10YEAR></d:BC_10YEAR>") +
      entry("2026-02-30", "<d:BC_10YEAR>4</d:BC_10YEAR>"),
  );
  expect(parseTreasuryXml(document, "DGS10")).toEqual([
    {
      observationDate: days[0],
      value: -0.5,
      source: "US Treasury / BC_10YEAR",
    },
  ]);
  expect(() =>
    parseTreasuryXml("<html>Access denied</html>", "DGS10"),
  ).toThrow();
});
it("BTC 翻页并排除未结束、非 UTC 日线及无效价格", async () => {
  deps.fetch
    .mockResolvedValueOnce(
      Response.json({
        bars: { "BTC/USD": [{ t: `${days[0]}T00:00:00Z`, c: 100 }] },
        next_page_token: "page2",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        bars: {
          "BTC/USD": [
            { t: `${days[1]}T00:00:00Z`, c: 101 },
            { t: "2026-09-23T00:00:00Z", c: 102 },
            { t: `${days[1]}T01:00:00Z`, c: 103 },
            { t: `${days[1]}T00:00:00Z`, c: null },
          ],
        },
        next_page_token: null,
      }),
    );
  const rows = await fetchAlpacaBtc("2026-09-23");
  expect(rows.map((r) => r.observationDate)).toEqual(days);
  expect(rows.every((r) => r.source === "Alpaca US / BTC/USD (UTC)")).toBe(
    true,
  );
  expect(
    new URL(deps.fetch.mock.calls[1][0]).searchParams.get("page_token"),
  ).toBe("page2");
});
it("主源已更新则不请求备用；主源过期时采用日期更近的备用", async () => {
  const backup = vi.fn(async () => [{ observationDate: days[1], value: 2 }]);
  const fresh = [{ observationDate: days[1], value: 1, source: "primary" }];
  expect(await freshestMacroValues(async () => fresh, backup, days[1])).toEqual(
    fresh,
  );
  expect(backup).not.toHaveBeenCalled();
  expect(
    await freshestMacroValues(
      async () => [{ ...fresh[0], observationDate: days[0] }],
      backup,
      days[1],
    ),
  ).toEqual(await backup());
});
it("主源失败使用备用；备用失败仍保留主源已有观测", async () => {
  const rows = [{ observationDate: days[0], value: 1 }];
  const fail = async () => {
    throw new Error("HTTP 503");
  };
  expect(await freshestMacroValues(fail, async () => rows, days[1])).toEqual(
    rows,
  );
  expect(await freshestMacroValues(async () => rows, fail, days[1])).toEqual(
    rows,
  );
  await expect(freshestMacroValues(fail, fail, days[1])).rejects.toThrow("503");
});
it("正式采集共用两次财政部请求，BTC 使用 Alpaca，保存来源且不请求旧源", async () => {
  deps.fetch.mockImplementation(async (url: URL | string) =>
    String(url).includes("treasury.gov")
      ? new Response(rates)
      : Response.json({
          bars: {
            "BTC/USD": days.map((d, i) => ({
              t: `${d}T00:00:00Z`,
              c: 100 + i,
            })),
          },
        }),
  );
  const archive = await refreshReviewMacro(days[1]);
  expect(archive.errors).toEqual([]);
  expect(
    deps.fetch.mock.calls.filter(([url]) =>
      String(url).includes("treasury.gov"),
    ),
  ).toHaveLength(2);
  expect(deps.yahoo.mock.calls.map(([symbol]) => symbol)).toEqual([
    "DX-Y.NYB",
    "CL=F",
    "GC=F",
  ]);
  expect(archive.series.BTC?.at(-1)?.source).toBe("Alpaca US / BTC/USD (UTC)");
  expect(archive.series.DGS10?.at(-1)?.source).toBe("US Treasury / BC_10YEAR");
  const macro = macroEnvironment(archive, days[1], days, now);
  expect(macro.rows.every((r) => r.status === "current")).toBe(true);
  expect(macro.rows.find((r) => r.id === "BTC")?.change).toBeCloseTo(1);
  expect(deps.write).toHaveBeenCalledWith("macro-observations", archive);
});
it("来源切换也保留首次可见记录，跨来源前值不算日涨跌", () => {
  const old = mergeObservations(
    [],
    days.map((observationDate) => ({ observationDate, value: 100 })),
    "2026-09-23T01:00:00Z",
  );
  const rows = mergeObservations(
    old,
    [
      {
        observationDate: days[1],
        value: 100,
        source: "Alpaca US / BTC/USD (UTC)",
      },
    ],
    now,
  );
  expect(rows).toHaveLength(3);
  expect(rows.at(-1)?.availableAt).toBe(now);
  const a: MacroArchive = {
    version: 1,
    updatedAt: now,
    errors: [],
    series: { BTC: rows },
  };
  expect(
    macroEnvironment(a, days[1], days, now).rows.find((r) => r.id === "BTC")
      ?.change,
  ).toBeNull();
  expect(
    macroEnvironment(a, days[1], days, "2026-09-23T02:00:00Z").rows.find(
      (r) => r.id === "BTC",
    )?.source,
  ).toBe("Yahoo / BTC-USD");
  expect(
    mergeObservations(
      rows,
      [
        {
          observationDate: days[1],
          value: 100,
          source: "Alpaca US / BTC/USD (UTC)",
        },
      ],
      "2026-09-24T01:00:00Z",
    ),
  ).toHaveLength(3);
});
