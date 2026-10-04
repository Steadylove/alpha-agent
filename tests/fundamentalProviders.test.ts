import { describe, expect, it, vi } from "vitest";
import { createFundamentalProvider as createProvider, fetchFundamentalInput as fetchInput,
  FundamentalRateLimitError, type FundamentalRequestObservation } from "@/lib/fundamental/providers";

const createFundamentalProvider: typeof createProvider = options => createProvider({ requestIntervalMs: 0, ...options });
const fetchFundamentalInput: typeof fetchInput = (symbol, options) => fetchInput(symbol, { requestIntervalMs: 0, ...options });

const now = new Date("2026-10-04T01:00:00.000Z");
const profile = (symbol: string, extra = {}) => ({ symbol, companyName: `${symbol} Inc.`,
  sector: "Technology", industry: "Software", currency: "USD", price: 100, marketCap: 1000,
  isEtf: false, isFund: false, isAdr: false, ...extra });
const income = (symbol: string, extra = {}) => ({ symbol, date: "2025-12-31", filingDate: "2026-02-01",
  acceptedDate: "2026-02-01 10:00:00", fiscalYear: "2025", period: "FY", reportedCurrency: "USD",
  revenue: 1000, netIncome: 100, operatingIncome: 150, epsDiluted: 2, weightedAverageShsOutDil: 50, ...extra });
const estimate = (symbol: string, date = "2026-12-31", extra = {}) => ({ symbol, date,
  epsLow: 3, epsAvg: 4, epsHigh: 5, revenueAvg: 1200, numAnalystsEps: 5, ...extra });
type Override = (endpoint: string, symbol: string, period: string | null) => unknown;
function fixture(override?: Override) {
  const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.split("/").at(-1)!;
    const symbol = url.searchParams.get("symbol")!;
    const period = url.searchParams.get("period");
    const custom = override?.(endpoint, symbol, period);
    if (custom instanceof Response) return custom;
    let result: unknown = custom;
    if (custom === undefined) {
      switch (endpoint) {
        case "profile": result = [profile(symbol)]; break;
        case "income-statement": result = period === "quarter"
          ? [income(symbol, { date: "2026-06-30", filingDate: "2026-08-01", period: "Q2", epsDiluted: 0.6 })]
          : [income(symbol)]; break;
        case "balance-sheet-statement": result = [income(symbol, { cashAndCashEquivalents: 200, totalDebt: 10 })]; break;
        case "cash-flow-statement": result = [income(symbol, { freeCashFlow: 80 })]; break;
        case "analyst-estimates": result = [estimate(symbol, "2027-12-31"), estimate(symbol)]; break;
        case "stock-peers": result = ["PAA", "PBB", "PCC"].map(peer => ({ symbol: peer })); break;
      }
    }
    return Response.json(result ?? []);
  });
  return { fetchImpl: fetchImpl as typeof fetch, spy: fetchImpl };
}

describe("Fundamental FMP provider", () => {
  it("preserves consensus observation time, fiscal dates, GAAP facts, diluted weighted shares and public sources", async () => {
    const { fetchImpl, spy } = fixture();
    const input = await fetchFundamentalInput(" test ", { now, apiKey: "private-key", fetchImpl });
    expect(input.symbol).toBe("TEST");
    expect(input.earningsBasis).toBe("non-gaap-consensus");
    expect(input.estimates.map(value => value.fiscalEnd)).toEqual(["2026-12-31", "2027-12-31"]);
    expect(input.financials).toMatchObject({ fiscalEnd: "2025-12-31", filedAt: "2026-02-01",
      reportedEps: 2, dilutedWeightedShares: 50, freeCashFlow: 80, cash: 200, debt: 10,
      latestQuarter: { fiscalEnd: "2026-06-30", filedAt: "2026-08-01", eps: 0.6 } });
    expect(input.peers.map(peer => peer.symbol)).toEqual(["PAA", "PBB", "PCC"]);
    expect(input.sources.find(value => value.id === "TEST:estimates")).toMatchObject({
      observedAt: now.toISOString(), publishedAt: null,
    });
    expect(JSON.stringify(input)).not.toContain("private-key");
    for (const [url, init] of spy.mock.calls) {
      expect(String(url)).not.toContain("private-key");
      expect(init?.headers).toEqual({ apikey: "private-key" });
    }
  });

  it("does not mix future filings, future fiscal ends, missing publication dates or different FY statements", async () => {
    const { fetchImpl } = fixture((endpoint, symbol, period) => {
      if (endpoint === "income-statement" && period === "annual") return [
        income(symbol, { date: "2026-12-31", filingDate: "2027-02-01", epsDiluted: 99 }),
        income(symbol, { filingDate: "2026-10-05", epsDiluted: 88 }),
        income(symbol, { date: "2026-06-30", filingDate: null, acceptedDate: null, epsDiluted: 77 }),
        income(symbol),
      ];
      if (endpoint === "balance-sheet-statement") return [income(symbol, { date: "2024-12-31", cashAndCashEquivalents: 900 })];
      if (endpoint === "cash-flow-statement") return [income(symbol, { reportedCurrency: "EUR", freeCashFlow: 999 })];
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.financials?.reportedEps).toBe(2);
    expect(input.financials?.cash).toBeNull();
    expect(input.financials?.debt).toBeNull();
    expect(input.financials?.freeCashFlow).toBeNull();
    expect(input.warnings.filter(value => value.includes("不混用其他财年"))).toHaveLength(2);
  });

  it("does not assume USD reporting from USD trading and excludes unrelated or nonordinary peers", async () => {
    const { fetchImpl } = fixture((endpoint, symbol) => {
      if (endpoint === "stock-peers") return ["OTHER", "ADR", "EUR", "BANK", "FUND", "GOOD"].map(value => ({ symbol: value }));
      if (endpoint === "profile" && symbol === "OTHER") return [profile(symbol, { industry: "Hardware" })];
      if (endpoint === "profile" && symbol === "ADR") return [profile(symbol, { isAdr: true })];
      if (endpoint === "income-statement" && symbol === "EUR") return [income(symbol, { reportedCurrency: "EUR" })];
      if (endpoint === "profile" && symbol === "BANK") return [profile(symbol, { sector: "Financial Services" })];
      if (endpoint === "profile" && symbol === "FUND") return [profile(symbol, { isFund: true })];
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.peers.map(peer => peer.symbol)).toEqual(["GOOD"]);
    expect(input.warnings.some(value => value.includes("至少需要 3 家"))).toBe(true);
  });

  it("returns partial inputs with safe permission errors instead of inventing missing estimates", async () => {
    const { fetchImpl } = fixture(endpoint => endpoint === "analyst-estimates"
      ? new Response("private-key may be in vendor errors", { status: 403 }) : undefined);
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "private-key", fetchImpl });
    expect(input.estimates).toEqual([]);
    expect(input.peers).toEqual([]);
    expect(input.warnings.join(" ")).toContain("HTTP 403");
    expect(JSON.stringify(input)).not.toContain("private-key");
  });

  it("handles API error objects and empty or malformed numeric values as unknown, not zero", async () => {
    const { fetchImpl } = fixture((endpoint, symbol) => {
      if (endpoint === "cash-flow-statement") return { "Error Message": "limit exceeded private-key" };
      if (endpoint === "analyst-estimates") return [estimate(symbol, "2026-12-31", {
        epsLow: null, epsAvg: "", epsHigh: "5", numAnalystsEps: 1.5,
      }), estimate("UNRELATED")];
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "private-key", fetchImpl });
    expect(input.estimates).toHaveLength(1);
    expect(input.estimates[0]).toMatchObject({ epsLow: null, epsAvg: null, epsHigh: null, analystCount: 0 });
    expect(input.financials?.freeCashFlow).toBeNull();
    expect(JSON.stringify(input)).not.toContain("private-key");
  });

  it("fails safely without profile or a key and rejects invalid symbols before sending requests", async () => {
    const { fetchImpl, spy } = fixture(endpoint => endpoint === "profile"
      ? new Response("apikey=private-key", { status: 401 }) : undefined);
    await expect(fetchFundamentalInput("TEST", { now, apiKey: "", fetchImpl })).rejects.toThrow("FMP_API_KEY");
    expect(spy).not.toHaveBeenCalled();
    await expect(fetchFundamentalInput("../TEST", { now, apiKey: "private-key", fetchImpl })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    await expect(fetchFundamentalInput("TEST", { now, apiKey: "private-key", fetchImpl })).rejects.toThrow("HTTP 401");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("shares overlapping requests within a job, but a new job fetches fresh observations", async () => {
    const { fetchImpl, spy } = fixture();
    const loader = createFundamentalProvider({ now, apiKey: "key", fetchImpl });
    await Promise.all([loader("TEST"), loader("PAA")]);
    const paths = spy.mock.calls.map(call => String(call[0]));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter(value => value.includes("/profile?symbol=PAA"))).toHaveLength(1);
    const previousCount = spy.mock.calls.length;
    await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(spy.mock.calls.length).toBeGreaterThan(previousCount);
  });

  it("caps accepted peers at eight and deduplicates malformed/self candidates", async () => {
    const { fetchImpl, spy } = fixture(endpoint => endpoint === "stock-peers"
      ? ["TEST", "../BAD", ...Array.from({ length: 12 }, (_, index) => `P${index}`), "P0"].map(symbol => ({ symbol }))
      : undefined);
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.peers).toHaveLength(8);
    expect(spy.mock.calls.some(call => String(call[0]).includes("symbol=P8"))).toBe(false);
  });

  it("checks supplier candidates beyond the first eight when earlier candidates are unsuitable", async () => {
    const { fetchImpl, spy } = fixture((endpoint, symbol) => {
      if (endpoint === "stock-peers") return Array.from({ length: 11 }, (_, index) => ({ symbol: `P${index}` }));
      if (endpoint === "profile" && /^P[0-7]$/.test(symbol)) return [profile(symbol, { industry: "Hardware" })];
      if (endpoint === "company-screener") return new Response("subscription required", { status: 402 });
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.peers.map(peer => peer.symbol)).toEqual(["P8", "P9", "P10"]);
    expect(spy.mock.calls.some(call => String(call[0]).includes("/company-screener?"))).toBe(false);
  });

  it("falls back to a shorter forecast window only on depth entitlement errors", async () => {
    const regular = fixture();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/analyst-estimates") && url.searchParams.get("limit") === "10") {
        return new Response("restricted depth", { status: 402 });
      }
      return regular.fetchImpl(input, init);
    }) as typeof fetch;
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.estimates).toHaveLength(2);
    expect(input.sources.find(value => value.id === "TEST:estimates")?.url).toContain("limit=5");
  });

  it("prefers safe filing links and never persists credential-bearing evidence URLs", async () => {
    const { fetchImpl } = fixture((endpoint, symbol, period) => {
      if (endpoint === "income-statement" && period === "annual") return [income(symbol, {
        finalLink: "https://www.sec.gov/Archives/edgar/data/1/filing.htm",
      })];
      if (endpoint === "cash-flow-statement") return [income(symbol, {
        freeCashFlow: 80, finalLink: "https://example.test/filing?apikey=private-key",
      })];
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "private-key", fetchImpl });
    expect(input.sources.find(value => value.id === "TEST:income:2025-12-31")?.url)
      .toBe("https://www.sec.gov/Archives/edgar/data/1/filing.htm");
    expect(input.sources.find(value => value.id === "TEST:cash-flow:2025-12-31")?.url)
      .toContain("financialmodelingprep.com/stable/cash-flow-statement");
    expect(JSON.stringify(input)).not.toContain("private-key");
  });

  it("bounds streamed response bodies and cancels HTTP error bodies without reading them", async () => {
    const cancel = vi.fn();
    const { fetchImpl } = fixture(endpoint => {
      if (endpoint === "analyst-estimates") return new Response(JSON.stringify([{ payload: "x".repeat(2 * 1024 * 1024) }]));
      if (endpoint === "cash-flow-statement") return new Response(new ReadableStream({ cancel }), { status: 403 });
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.estimates).toEqual([]);
    expect(input.warnings.join(" ")).toContain("年度盈利预测不可用");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("counts distinct issuers, excluding the main company's other share class and peer duplicate CIKs", async () => {
    const { fetchImpl } = fixture((endpoint, symbol) => {
      if (endpoint === "stock-peers") return ["TESTB", "GOOG", "GOOGL", "PAA", "PBB"].map(value => ({ symbol: value }));
      if (endpoint === "profile") return [profile(symbol, {
        cik: symbol === "TEST" ? "000001" : symbol === "TESTB" ? "1" :
          symbol === "GOOG" ? "0001652044" : symbol === "GOOGL" ? "1652044" : symbol === "PAA" ? "2" : "3",
      })];
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.peers.map(peer => peer.symbol)).toEqual(["GOOG", "PAA", "PBB"]);
  });

  it("uses normalized company names only as a documented CIK fallback, and rejects unknown issuer identity", async () => {
    const { fetchImpl } = fixture((endpoint, symbol) => {
      if (endpoint === "stock-peers") return ["TESTB", "PAA", "PAB", "UNKNOWN", "PBB", "PCC"].map(value => ({ symbol: value }));
      if (endpoint === "profile" && symbol === "TESTB") return [profile(symbol, { companyName: "Test Inc. Class B" })];
      if (endpoint === "profile" && symbol === "PAA") return [profile(symbol, { companyName: "Alpha, Inc." })];
      if (endpoint === "profile" && symbol === "PAB") return [profile(symbol, { companyName: "ALPHA INC" })];
      if (endpoint === "profile" && symbol === "UNKNOWN") return [profile(symbol, { companyName: "", cik: "000000" })];
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.peers.map(peer => peer.symbol)).toEqual(["PAA", "PBB", "PCC"]);
    expect(input.warnings.some(value => value.includes("规范化公司名称"))).toBe(true);
    expect(input.warnings.some(value => value.includes("UNKNOWN") && value.includes("未计作独立同业"))).toBe(true);
  });

  it("falls back only for insufficient valid peers, ranks same-industry market caps and caps final peers at eight", async () => {
    const { fetchImpl, spy } = fixture((endpoint, symbol) => {
      if (endpoint === "stock-peers") return [{ symbol: "OLD" }];
      if (endpoint === "profile" && symbol === "OLD") return [profile(symbol, { industry: "Hardware" })];
      if (endpoint === "company-screener") return [
        { symbol: "WRONG", industry: "Hardware", marketCap: 1000 },
        ...Array.from({ length: 20 }, (_, index) => ({ symbol: `F${index}`, industry: "Software", marketCap: 1000 + index * 100 })),
      ].reverse();
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.peers.map(peer => peer.symbol)).toEqual(["F0", "F1", "F2", "F3", "F4", "F5", "F6", "F7"]);
    const screenerCall = spy.mock.calls.find(call => String(call[0]).includes("/company-screener?"));
    expect(new URL(String(screenerCall?.[0])).searchParams.get("industry")).toBe("Software");
    expect(new URL(String(screenerCall?.[0])).searchParams.has("symbol")).toBe(false);
    expect(spy.mock.calls.some(call => String(call[0]).includes("symbol=F8"))).toBe(false);
    const regular = fixture();
    await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl: regular.fetchImpl });
    expect(regular.spy.mock.calls.some(call => String(call[0]).includes("/company-screener?"))).toBe(false);
  });

  it("shares the twenty-candidate budget across supplier and screener candidates", async () => {
    const { fetchImpl, spy } = fixture((endpoint, symbol) => {
      if (endpoint === "stock-peers") return Array.from({ length: 12 }, (_, index) => ({ symbol: `P${index}` }));
      if (endpoint === "company-screener") return Array.from({ length: 30 }, (_, index) => ({
        symbol: `F${index}`, industry: "Software", marketCap: 1000 + index * 100,
      }));
      if (endpoint === "profile" && symbol !== "TEST") return [profile(symbol, { industry: "Hardware" })];
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.peers).toEqual([]);
    const peerProfiles = spy.mock.calls.filter(call => String(call[0]).includes("/profile?") &&
      !String(call[0]).includes("symbol=TEST"));
    expect(peerProfiles).toHaveLength(20);
    expect(peerProfiles.some(call => String(call[0]).includes("symbol=F12"))).toBe(false);
  });

  it("runs the fallback when three profile peers do not have usable NTM EPS", async () => {
    const { fetchImpl, spy } = fixture((endpoint, symbol) => {
      if (endpoint === "analyst-estimates" && symbol !== "TEST") return [estimate(symbol, "2026-12-31", { numAnalystsEps: 1 })];
      if (endpoint === "company-screener") return [];
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.peers).toEqual([]);
    expect(spy.mock.calls.some(call => String(call[0]).includes("/company-screener?"))).toBe(true);
  });

  it("uses a local industry directory before the paid screener, with alphabetical ordering and final FMP industry verification", async () => {
    const { fetchImpl, spy } = fixture((endpoint, symbol) => {
      if (endpoint === "stock-peers") return [];
      if (endpoint === "profile" && symbol === "BAD") return [profile(symbol, { industry: "Hardware" })];
    });
    const peerDirectory = [
      { symbol: "CCC", industry: "Systems Software", rps: 99 },
      { symbol: "TEST", industry: "Systems Software", rps: 80 },
      { symbol: "BAD", industry: "Systems Software", rps: 95 },
      { symbol: "BBB", industry: "Systems Software", rps: 100 },
      { symbol: "AAA", industry: "Systems Software", rps: 1 },
      { symbol: "OTHER", industry: "Application Software", rps: 100 },
    ];
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl, peerDirectory });
    expect(input.peers.map(peer => peer.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    expect(input.peers.every(peer => peer.industry === "Software")).toBe(true);
    expect(input.warnings.some(value => value.includes("本地行业目录"))).toBe(true);
    expect(spy.mock.calls.some(call => String(call[0]).includes("/company-screener?"))).toBe(false);
    expect(spy.mock.calls.some(call => String(call[0]).includes("symbol=OTHER"))).toBe(false);
  });

  it("shares the twenty-candidate budget across supplier and local-directory candidates", async () => {
    const { fetchImpl, spy } = fixture((endpoint, symbol) => {
      if (endpoint === "stock-peers") return Array.from({ length: 8 }, (_, index) => ({ symbol: `P${index}` }));
      if (endpoint === "profile" && symbol !== "TEST") return [profile(symbol, { industry: "Hardware" })];
    });
    const peerDirectory = [{ symbol: "TEST", industry: "Systems Software" },
      ...Array.from({ length: 40 }, (_, index) => ({ symbol: `D${index}`, industry: "Systems Software" }))];
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl, peerDirectory });
    expect(input.peers).toEqual([]);
    const profileCalls = spy.mock.calls.filter(call => String(call[0]).includes("/profile?") && !String(call[0]).includes("symbol=TEST"));
    expect(profileCalls).toHaveLength(20);
    expect(spy.mock.calls.some(call => String(call[0]).includes("/company-screener?"))).toBe(false);
  });

  it("leaves remaining candidate capacity for the screener when the local directory is insufficient", async () => {
    const { fetchImpl, spy } = fixture(endpoint => {
      if (endpoint === "stock-peers") return [];
      if (endpoint === "company-screener") return ["BBB", "CCC"].map(symbol => ({ symbol, industry: "Software", marketCap: 1000 }));
    });
    const peerDirectory = [{ symbol: "TEST", industry: "Systems Software" }, { symbol: "AAA", industry: "Systems Software" }];
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl, peerDirectory });
    expect(input.peers.map(peer => peer.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    expect(spy.mock.calls.some(call => String(call[0]).includes("/company-screener?"))).toBe(true);
  });

  it("distinguishes inaccessible peer financials from a genuinely absent peer universe", async () => {
    const { fetchImpl } = fixture((endpoint, symbol, period) => {
      if (endpoint === "income-statement" && period === "annual" && symbol !== "TEST")
        return new Response("subscription required", { status: 402 });
    });
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl });
    expect(input.financials).not.toBeNull();
    expect(input.peers).toEqual([]);
    expect(input.warnings.some(value => value.includes("PAA") && value.includes("年度财报不可用（HTTP 402）"))).toBe(true);
  });

  it("emits sanitized diagnostics once per actual request, excluding secrets and response bodies", async () => {
    const { fetchImpl, spy } = fixture(endpoint => endpoint === "analyst-estimates"
      ? new Response("private-key URL token", { status: 403 }) : undefined);
    const observations: FundamentalRequestObservation[] = [];
    const loader = createFundamentalProvider({ now, apiKey: "private-key", fetchImpl,
      onRequest: observation => observations.push(observation) });
    await loader("TEST"); await loader("TEST");
    expect(observations).toHaveLength(spy.mock.calls.length);
    expect(observations.some(row => row.endpoint === "analyst-estimates" && row.httpStatus === 403 && row.status === "http-error")).toBe(true);
    expect(JSON.stringify(observations)).not.toContain("private-key");
    expect(JSON.stringify(observations)).not.toContain("URL token");
    expect(JSON.stringify(observations)).not.toContain("https://");
  });

  it("keeps diagnostics callback failures from interrupting financial collection", async () => {
    const { fetchImpl } = fixture();
    const input = await fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl,
      onRequest: () => { throw new Error("observer failed"); } });
    expect(input.financials).not.toBeNull();
    expect(input.peers).toHaveLength(3);
  });

  it("opens a job-wide circuit after HTTP 429, without retries or fake request observations", async () => {
    const { fetchImpl, spy } = fixture((endpoint, symbol) => endpoint === "profile" && symbol === "PAA"
      ? new Response("private-key vendor body", { status: 429 }) : undefined);
    const observations: FundamentalRequestObservation[] = [];
    const loader = createFundamentalProvider({ now, apiKey: "private-key", fetchImpl,
      onRequest: row => observations.push(row) });
    await expect(loader("TEST")).rejects.toBeInstanceOf(FundamentalRateLimitError);
    const called = spy.mock.calls.length;
    await expect(loader("MSFT")).rejects.toThrow("HTTP 429");
    await expect(loader("TEST")).rejects.toBeInstanceOf(FundamentalRateLimitError);
    expect(spy).toHaveBeenCalledTimes(called);
    expect(observations).toHaveLength(called);
    expect(observations.at(-1)).toMatchObject({ symbol: "PAA", httpStatus: 429 });
    expect(spy.mock.calls.some(([url]) => String(url).includes("symbol=PBB"))).toBe(false);
    // Rate limits do not poison a future independent job, which gets a fresh request cache/circuit.
    const nextJob = fixture();
    await expect(fetchFundamentalInput("TEST", { now, apiKey: "private-key", fetchImpl: nextJob.fetchImpl })).resolves.toHaveProperty("symbol", "TEST");
  });

  it("stops new peer requests when one of the bounded parallel financial requests is rate-limited", async () => {
    const { fetchImpl, spy } = fixture(endpoint => endpoint === "analyst-estimates"
      ? new Response("limit", { status: 429 }) : undefined);
    await expect(fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl })).rejects.toBeInstanceOf(FundamentalRateLimitError);
    expect(spy).toHaveBeenCalledTimes(7); // Profile plus the already-started own-data request group.
    expect(spy.mock.calls.every(([url]) => new URL(String(url)).searchParams.get("symbol") === "TEST")).toBe(true);
  });

  it("spaces request starts and prevents queued own-data requests from reaching fetch after a 429", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { fetchImpl } = fixture(endpoint => endpoint === "income-statement"
        ? new Response("rate limit", { status: 429 }) : undefined);
      const starts: number[] = [];
      const observed: FundamentalRequestObservation[] = [];
      const pacedFetch = vi.fn((...args: Parameters<typeof fetch>) => {
        starts.push(Date.now());
        return fetchImpl(...args);
      });
      const result = fetchFundamentalInput("TEST", { now, apiKey: "key", fetchImpl: pacedFetch,
        requestIntervalMs: 1000, onRequest: row => observed.push(row) });
      const rejected = expect(result).rejects.toBeInstanceOf(FundamentalRateLimitError);
      await vi.runAllTimersAsync();
      await rejected;
      expect(starts).toEqual([now.getTime(), now.getTime() + 1000]);
      expect(pacedFetch).toHaveBeenCalledTimes(2);
      expect(observed).toHaveLength(2);
      expect(observed.at(-1)).toMatchObject({ endpoint: "income-statement", httpStatus: 429 });
    } finally { vi.useRealTimers(); }
  });
});
