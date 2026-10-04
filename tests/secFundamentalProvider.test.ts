import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecFundamentalProvider, SecFundamentalAccessError, SecFundamentalConfigurationError } from "../src/lib/fundamental/secProvider";
import { calculateValuation } from "../src/lib/fundamental/engine";
import { SEC_SCENARIO_RULE } from "../src/lib/fundamental/types";

type Fact = { start?: string; end: string; val: number; filed: string; accn: string; form: string };
type CompanyFacts = { cik: number; facts: { "us-gaap": Record<string, { units: Record<string, Fact[]> }> } };
const names = { revenue: "RevenueFromContractWithCustomerExcludingAssessedTax", netIncome: "NetIncomeLoss", operatingIncome: "OperatingIncomeLoss", operatingCashFlow: "NetCashProvidedByUsedInOperatingActivities", capex: "PaymentsToAcquirePropertyPlantAndEquipment", shares: "WeightedAverageNumberOfDilutedSharesOutstanding" };
const now = new Date("2025-11-01T12:00:00Z");
// This identity is used only with an injected mock fetch; tests never contact SEC.
const userAgent = "Test fixture research@institution.org";
const accn = (year: number, id: number) => `0000000001-${String(year).slice(-2)}-${String(id).padStart(6, "0")}`;
function fixture(cik = 1) {
  const data: CompanyFacts = { cik, facts: { "us-gaap": {} } };
  function add(key: keyof typeof names, start: string, end: string, val: number, filed: string, accession: string, form = "10-Q") {
    const units = (data.facts["us-gaap"][names[key]] ??= { units: {} }).units;
    (units[key === "shares" ? "shares" : "USD"] ??= []).push({ start, end, val, filed, accn: accession, form });
  }
  function flows(start: string, end: string, ni: number, filed: string, accession: string, form = "10-Q") {
    for (const [key, multiplier] of [["revenue", 10], ["netIncome", 1], ["operatingIncome", 1.5], ["operatingCashFlow", 1.8], ["capex", 0.3]] as const) add(key, start, end, ni * multiplier, filed, accession, form);
  }
  flows("2023-01-01", "2023-12-31", 100, "2024-02-01", accn(2024, 10), "10-K");
  flows("2024-01-01", "2024-12-31", 120, "2025-02-01", accn(2025, 10), "10-K");
  for (const [year, income] of [[2023, 70], [2024, 90], [2025, 105]]) {
    flows(`${year}-01-01`, `${year}-09-30`, income, `${year}-10-25`, accn(year, 30));
    add("netIncome", `${year}-07-01`, `${year}-09-30`, income / 3, `${year}-10-25`, accn(year, 30));
    add("shares", `${year}-07-01`, `${year}-09-30`, 10, `${year}-10-25`, accn(year, 30));
    add("shares", `${year}-04-01`, `${year}-06-30`, 10, `${year}-07-25`, accn(year, 20));
  }
  return { data, add, flows };
}
function harness(options: { facts?: CompanyFacts; status?: number; meta?: Record<string, unknown>; tickers?: Record<string, unknown>; more?: Record<string, CompanyFacts> } = {}) {
  const facts = options.facts ?? fixture().data;
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (options.status) return new Response("untrusted upstream body", { status: options.status });
    if (url.includes("company_tickers")) return Response.json(options.tickers ?? { "0": { ticker: "TEST", cik_str: 1 } });
    const cik = Number(url.match(/CIK(\d+)\.json/)?.[1]);
    if (url.includes("submissions")) return Response.json({ cik, name: `Company ${cik}`, tickers: [cik === 1 ? "TEST" : `PEER${cik}`], entityType: "operating", sic: "3571", sicDescription: "Electronic Computers", stateOfIncorporation: "DE", filings: { recent: { form: ["10-Q", "10-K"], filingDate: ["2025-10-25", "2025-02-01"] } }, ...options.meta });
    return Response.json(options.more?.[String(cik)] ?? facts);
  }) as unknown as typeof fetch;
  const quoteReader = vi.fn(() => ({ price: 100, observedAt: "2025-10-31T23:59:59.000Z" }));
  return { fetchFn, quoteReader, provider: createSecFundamentalProvider({ userAgent, now, fetchFn, quoteReader, requestIntervalMs: 0, peerDirectory: [{ symbol: "TEST", industry: "Hardware" }] }) };
}
afterEach(() => vi.useRealTimers());

describe("free SEC fundamental provider", () => {
  it("builds aligned TTM from annual plus current YTD minus prior YTD with quarterly share denominator", async () => {
    const { provider } = harness();
    const input = await provider(" test ");
    expect(input.scenario?.current).toMatchObject({ periodStart: "2024-10-01", periodEnd: "2025-09-30", revenue: 1350, netIncome: 135, operatingIncome: 202.5, operatingCashFlow: 243, capex: 40.5, dilutedShares: 10, latestQuarterEps: 3.5 });
    expect(input.scenario?.prior).toMatchObject({ periodStart: "2023-10-01", periodEnd: "2024-09-30", netIncome: 120 });
    expect(input.financials?.reportedEps).toBe(13.5);
    expect(input.earningsBasis).toBe("gaap-derived-scenario");
    expect(input.estimates).toEqual([]);
    expect(input.peers).toEqual([]);
    expect(input.industry).toBe("SEC SIC 3571 · Electronic Computers");
    expect(input.sources.every(source => !source.url.includes("research@"))).toBe(true);
    expect(input.scenario?.current.sourceIds.every(id => input.sources.some(source => source.id === id))).toBe(true);
    expect(input.warnings.join(" ")).toContain("原始供应商未随 CSV 留档，非实时");
    expect(input.sources.every(source => new URL(source.url).hostname.endsWith("sec.gov"))).toBe(true);
  });

  it("uses latest coherent restatements and excludes same-day and future facts", async () => {
    const f = fixture();
    f.flows("2025-01-01", "2025-09-30", 115, "2025-10-30", accn(2025, 40), "10-Q/A");
    f.add("netIncome", "2025-07-01", "2025-09-30", 45, "2025-10-30", accn(2025, 40), "10-Q/A");
    f.add("shares", "2025-07-01", "2025-09-30", 10, "2025-10-30", accn(2025, 40), "10-Q/A");
    f.flows("2025-01-01", "2025-09-30", 999, "2025-11-01", accn(2025, 50));
    f.flows("2026-01-01", "2026-09-30", 999, "2026-10-25", accn(2026, 30));
    const input = await harness({ facts: f.data }).provider("TEST");
    expect(input.scenario?.current.netIncome).toBe(145);
    expect(input.scenario?.current.latestQuarterEps).toBe(4.5);
    expect(input.scenario?.current.filedAt).toBe("2025-10-30");
  });

  it("does not silently fall back past a partial material restatement", async () => {
    const f = fixture();
    f.add("netIncome", "2025-01-01", "2025-09-30", 777, "2025-10-30", accn(2025, 40));
    const input = await harness({ facts: f.data }).provider("TEST");
    expect(input.scenario).toBeUndefined();
    expect(input.warnings.join(" ")).toContain("重述");
  });

  it.each(["netIncome", "shares"] as const)("does not fall back to stale quarter %s when only one field was restated", async key => {
    const f = fixture();
    f.add(key, "2025-07-01", "2025-09-30", key === "shares" ? 11 : 40, "2025-10-30", accn(2025, 40), "10-Q/A");
    const input = await harness({ facts: f.data }).provider("TEST");
    expect(input.scenario).toBeUndefined();
    expect(input.warnings.join(" ")).toContain("较新重述");
  });

  it.each(["capex", "operatingCashFlow", "shares"] as const)("reports missing %s without manufacturing a value", async key => {
    const f = fixture(); delete f.data.facts["us-gaap"][names[key]];
    const input = await harness({ facts: f.data }).provider("TEST");
    expect(input.scenario).toBeUndefined();
    expect(input.financials).toBeNull();
  });

  it("supports annual TTM with directly reported Q4 shares and earnings", async () => {
    const f = fixture();
    f.flows("2025-01-01", "2025-12-31", 150, "2026-02-01", accn(2026, 10), "10-K");
    for (const year of [2024, 2025]) {
      f.add("netIncome", `${year}-10-01`, `${year}-12-31`, 40, `${year + 1}-02-01`, accn(year + 1, 10), "10-K");
      f.add("shares", `${year}-10-01`, `${year}-12-31`, 10, `${year + 1}-02-01`, accn(year + 1, 10), "10-K");
    }
    const h = harness({ facts: f.data });
    const input = await createSecFundamentalProvider({ userAgent, now: new Date("2026-02-05T12:00:00Z"), fetchFn: h.fetchFn, quoteReader: () => ({ price: 100, observedAt: "2026-02-04T23:59:59.000Z" }), requestIntervalMs: 0 })("TEST");
    expect(input.scenario?.current).toMatchObject({ periodStart: "2025-01-01", periodEnd: "2025-12-31", netIncome: 150, latestQuarterEps: 4 });
  });

  it("does not derive Q4 diluted shares even from same-accession annual and 9M averages", async () => {
    const f = fixture();
    f.flows("2025-01-01", "2025-12-31", 150, "2026-02-01", accn(2026, 10), "10-K");
    for (const [year, nine] of [[2024, 90], [2025, 105]]) {
      const id = accn(year + 1, 10), filed = `${year + 1}-02-01`;
      f.add("netIncome", `${year}-01-01`, `${year}-09-30`, nine, filed, id, "10-K");
      f.add("shares", `${year}-01-01`, `${year}-09-30`, 10, filed, id, "10-K");
      f.add("shares", `${year}-01-01`, `${year}-12-31`, 10, filed, id, "10-K");
    }
    const h = harness({ facts: f.data });
    const input = await createSecFundamentalProvider({ userAgent, now: () => new Date("2026-02-05T12:00:00Z"), fetchFn: h.fetchFn, quoteReader: () => null, requestIntervalMs: 0 })("TEST");
    expect(input.scenario).toBeUndefined();
    expect(input.warnings.join(" ")).toContain("稀释加权股数");
  });

  it.each([["shares", "2025-12-31", 11], ["shares", "2025-09-30", 11], ["netIncome", "2025-09-30", 110], ["netIncome", "2025-12-31", 160]] as const)("does not derive Q4 using stale %s through %s", async (key, end, value) => {
    const f = fixture();
    f.flows("2025-01-01", "2025-12-31", 150, "2026-02-01", accn(2026, 10), "10-K");
    for (const [year, nine] of [[2024, 90], [2025, 105]]) {
      const id = accn(year + 1, 10), filed = `${year + 1}-02-01`;
      f.add("netIncome", `${year}-01-01`, `${year}-09-30`, nine, filed, id, "10-K");
      f.add("shares", `${year}-01-01`, `${year}-09-30`, 10, filed, id, "10-K");
      f.add("shares", `${year}-01-01`, `${year}-12-31`, 10, filed, id, "10-K");
    }
    f.add(key, "2025-01-01", end, value, "2026-02-03", accn(2026, 11), "10-K/A");
    const h = harness({ facts: f.data });
    const input = await createSecFundamentalProvider({ userAgent, now: new Date("2026-02-05T12:00:00Z"), fetchFn: h.fetchFn, quoteReader: () => null, requestIntervalMs: 0 })("TEST");
    expect(input.scenario).toBeUndefined();
    expect(input.warnings.join(" ")).toMatch(/重述|稀释加权股数/);
  });

  it("derives additive Q4 income only when Q4 diluted shares are directly reported", async () => {
    const f = fixture();
    f.flows("2025-01-01", "2025-12-31", 150, "2026-02-01", accn(2026, 10), "10-K");
    for (const year of [2024, 2025]) f.add("shares", `${year}-10-01`, `${year}-12-31`, 10, `${year + 1}-02-01`, accn(year + 1, 10), "10-K");
    const h = harness({ facts: f.data });
    const input = await createSecFundamentalProvider({ userAgent, now: new Date("2026-02-05T12:00:00Z"), fetchFn: h.fetchFn, quoteReader: () => null, requestIntervalMs: 0 })("TEST");
    expect(input.scenario?.current.dilutedShares).toBe(10);
    expect(input.scenario?.current.latestQuarterEps).toBe(4.5);
    expect(input.scenario?.prior.latestQuarterEps).toBe(3);
  });

  it("blocks cross-filing Q4 income subtraction when the nine-month income was restated", async () => {
    const f = fixture();
    f.flows("2025-01-01", "2025-12-31", 150, "2026-02-01", accn(2026, 10), "10-K");
    for (const year of [2024, 2025]) f.add("shares", `${year}-10-01`, `${year}-12-31`, 10, `${year + 1}-02-01`, accn(year + 1, 10), "10-K");
    f.add("netIncome", "2025-01-01", "2025-09-30", 115, "2026-02-03", accn(2026, 11), "10-Q/A");
    const h = harness({ facts: f.data });
    const input = await createSecFundamentalProvider({ userAgent, now: new Date("2026-02-05T12:00:00Z"), fetchFn: h.fetchFn, quoteReader: () => null, requestIntervalMs: 0 })("TEST");
    expect(input.scenario).toBeUndefined();
    expect(input.warnings.join(" ")).toContain("跨申报 Q4 净利");
  });

  it.each(["future", "stale"])("rejects a %s saved quote", async kind => {
    const h = harness();
    const input = await createSecFundamentalProvider({ userAgent, now, fetchFn: h.fetchFn, quoteReader: () => ({ price: 100, observedAt: kind === "future" ? "2025-11-02T00:00:00Z" : "2025-10-01T00:00:00Z" }), requestIntervalMs: 0 })("TEST");
    expect(input.quote).toBeNull();
    expect(input.warnings.join(" ")).toContain("7 日内");
  });

  it("blocks an instant split fact and large quarter share jump", async () => {
    const f = fixture();
    f.data.facts["us-gaap"].StockSplitConversionRatio = { units: { pure: [{ end: "2025-10-10", val: 2, filed: "2025-10-20", accn: accn(2025, 70), form: "8-K" }] } };
    const input = await harness({ facts: f.data }).provider("TEST");
    expect(input.scenario).toBeUndefined();
    expect(input.warnings.join(" ")).toContain("拆股");
    delete f.data.facts["us-gaap"].StockSplitConversionRatio;
    f.data.facts["us-gaap"][names.shares].units.shares.find(row => row.end === "2025-09-30")!.val = 20;
    expect((await harness({ facts: f.data }).provider("TEST")).warnings.join(" ")).toContain("20%");
  });

  it.each(["NetIncomeLossAvailableToCommonStockholdersBasic", "PreferredStockDividends", "PreferredStockDividendsAndOtherAdjustments"])("blocks unresolved common shareholder earnings adjustments in %s", async tag => {
    const f = fixture();
    f.data.facts["us-gaap"][tag] = { units: { USD: [{ start: "2025-01-01", end: "2025-09-30", val: 5, filed: "2025-10-25", accn: accn(2025, 30), form: "10-Q" }] } };
    const input = await harness({ facts: f.data }).provider("TEST");
    expect(input.scenario).toBeUndefined();
    expect(input.warnings.join(" ")).toContain("普通股");
  });

  it("replaces rejected candidates while retaining at most eight distinct peer issuers", async () => {
    const tickerRows: Record<string, unknown> = { "0": { ticker: "TEST", cik_str: 1 }, "99": { ticker: "SELFCLASS", cik_str: 1 } };
    const more: Record<string, CompanyFacts> = {};
    const peerDirectory = [{ symbol: "TEST", industry: "Hardware" }, { symbol: "SELFCLASS", industry: "Hardware" }];
    for (let cik = 2; cik <= 12; cik++) {
      tickerRows[String(cik)] = { ticker: `PEER${cik}`, cik_str: cik };
      more[String(cik)] = fixture(cik).data;
      peerDirectory.push({ symbol: `PEER${cik}`, industry: "Hardware" });
    }
    const h = harness({ tickers: tickerRows, more });
    const fetchFn: typeof fetch = async (...args) => {
      const response = await h.fetchFn(...args);
      if (String(args[0]).includes("submissions/CIK0000000010")) {
        const json = await response.json(); json.sic = "3674"; return Response.json(json);
      }
      return response;
    };
    const input = await createSecFundamentalProvider({ userAgent, now, fetchFn, quoteReader: h.quoteReader, requestIntervalMs: 0, peerDirectory })("TEST");
    expect(input.scenario?.peers.map(row => row.symbol)).toEqual(["PEER11", "PEER12", "PEER2", "PEER3", "PEER4", "PEER5", "PEER6", "PEER7"]);
    expect(input.warnings.join(" ")).toContain("SIC");
    expect(input.sources.length).toBeLessThanOrEqual(80);
    for (const peer of input.scenario!.peers) expect(peer.current.sourceIds.every(id => input.sources.some(source => source.id === id))).toBe(true);
    expect(vi.mocked(h.fetchFn).mock.calls.filter(call => String(call[0]).includes("CIK0000000001"))).toHaveLength(2);
    const result = calculateValuation(input, { now });
    expect(result.reasons).toEqual([]);
    expect(result.valuation).not.toBeNull();
    expect(result.valuation?.rule).toBe(SEC_SCENARIO_RULE);
  });

  it.each([{ sic: "6021" }, { entityType: "investment" }, { stateOfIncorporation: "E9" }, { filings: { recent: { form: ["20-F"], filingDate: ["2025-10-01"] } } }])("rejects unsupported or unknown issuer metadata", async meta => {
    expect((await harness({ meta }).provider("TEST")).scenario).toBeUndefined();
  });

  it("caches all three SEC responses across repeated and concurrent symbol collection", async () => {
    const h = harness();
    await Promise.all([h.provider("TEST"), h.provider("TEST")]);
    await h.provider("TEST");
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
  });

  it.each([403, 429])("opens the job circuit on HTTP %s without exposing upstream text", async status => {
    const h = harness({ status });
    await expect(h.provider("TEST")).rejects.toBeInstanceOf(SecFundamentalAccessError);
    await expect(h.provider("OTHER")).rejects.toThrow(`SEC HTTP ${status}`);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("validates explicit identity only when collection runs and makes no request when absent", async () => {
    const h = harness();
    const provider = createSecFundamentalProvider({ userAgent: "", fetchFn: h.fetchFn });
    await expect(provider("TEST")).rejects.toBeInstanceOf(SecFundamentalConfigurationError);
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("paces shared requests at one second and emits only sanitized diagnostics", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const h = harness(), observations: unknown[] = [];
    const starts: number[] = [];
    const provider = createSecFundamentalProvider({ userAgent, now, fetchImpl: async (...args) => { starts.push(Date.now()); return h.fetchFn(...args); }, quoteReader: () => null, onRequest: row => observations.push(row) });
    const promise = provider("TEST");
    await vi.runAllTimersAsync(); await promise;
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1000);
    expect(JSON.stringify(observations)).not.toContain("https://");
    expect(JSON.stringify(observations)).not.toContain("research@");
  });
});
