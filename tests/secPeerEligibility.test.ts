import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSecFundamentalProvider } from "../src/lib/fundamental/secProvider";
import { calculateValuation } from "../src/lib/fundamental/engine";

const saved = JSON.parse(readFileSync(new URL("./fixtures/sec-cash-dividends-2026.json", import.meta.url), "utf8"));
const base = saved.cases.find((row: { symbol: string }) => row.symbol === "CRM");
const now = new Date("2026-10-04T12:00:00.000Z");
type Entry = { symbol: string; industry: string; sector?: string; sic?: number; price?: number };
async function collect(entries: Entry[], options: { knownSymbols?: string[]; coverState?: string } = {}) {
  const rows = [{ symbol: "TEST", industry: "Equipment", sector: "Technology" }, ...entries];
  const fetchFn: typeof fetch = async input => {
    const url = String(input);
    if (url.includes("company_tickers")) return Response.json(Object.fromEntries(rows.map((row, i) => [i, { ticker: row.symbol, cik_str: i + 1 }])));
    if (url.includes("/Archives/")) return new Response(`<ix:nonNumeric name="dei:EntityIncorporationStateCountryCode" contextRef="c1">${options.coverState}</ix:nonNumeric>`);
    const cik = Number(url.match(/CIK(\d+)\.json/)?.[1]), row = rows[cik - 1];
    if (!row) throw new Error("Unexpected fixture request");
    if (url.includes("submissions")) return Response.json({ ...base.submissions, cik, name: row.symbol, tickers: [row.symbol], sic: row.sic ?? 7372, sicDescription: "Test peer category", stateOfIncorporation: cik === 1 && options.coverState ? "" : "DE",
      ...(cik === 1 && options.coverState ? { filings: { recent: { form: ["10-K"], filingDate: ["2026-03-01"], accessionNumber: ["0000000001-26-000001"], primaryDocument: ["annual.htm"] } } } : {}) });
    return Response.json({ ...base.companyfacts, cik });
  };
  const input = await createSecFundamentalProvider({ userAgent: "Offline test research@institution.org", now,
    requestIntervalMs: 0, peerDirectory: rows, fetchFn,
    issuerDirectory: rows.flatMap((row, i) => options.knownSymbols?.includes(row.symbol) ? [{ symbol: row.symbol,
      cik: String(i + 1).padStart(10, "0"), sic: row.sic ?? 7372, observedAt: "2026-10-03T12:00:00.000Z",
      sourceUrl: `https://data.sec.gov/submissions/CIK${String(i + 1).padStart(10, "0")}.json` }] : []),
    quoteReader: symbol => ({ price: rows.find(row => row.symbol === symbol)?.price ?? 100, observedAt: "2026-10-02T23:59:59.000Z" }),
  })("TEST");
  return { input, result: calculateValuation(input, { now }) };
}

describe("SEC peer discovery and retained eligibility", () => {
  it("continues past eight complete but ineligible peers to later valid issuers", async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ symbol: `PEER${String(i).padStart(2, "0")}`,
      industry: "Equipment", sector: "Technology", price: i < 8 ? 100_000_000 : 100 }));
    const { input, result } = await collect(entries);
    expect(input.scenario?.peers.map(row => row.symbol)).toEqual(["PEER08", "PEER09", "PEER10", "PEER11"]);
    expect(input.warnings.join(" ")).toContain("P/E");
    expect(input.sources.some(source => source.id.startsWith("sec:0000000002:"))).toBe(false);
    expect(result.valuation).not.toBeNull();
  });

  it("discovers exact SIC peers across directory industries without admitting a different SIC", async () => {
    const { input, result } = await collect([
      { symbol: "WRONG", industry: "Equipment", sector: "Technology", sic: 3571 },
      ...["AAA", "BBB", "CCC"].map(symbol => ({ symbol, industry: "Software", sector: "Technology" })),
      { symbol: "ELSEWHERE", industry: "Pharma", sector: "Health Care" },
    ]);
    expect(input.scenario?.peers.map(row => row.symbol)).toEqual(["AAA", "BBB", "CCC"]);
    expect(input.warnings.join(" ")).toContain("SIC");
    expect(result.valuation).not.toBeNull();
  });

  it("keeps the discovery budget deterministic and independent of screener order", async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ symbol: `PEER${String(i).padStart(2, "0")}`,
      industry: "Equipment", sector: "Technology", price: i < 24 ? 100_000_000 : 100 }));
    const forward = await collect(entries), reversed = await collect([...entries].reverse());
    expect(forward.input.scenario?.peers).toEqual([]);
    expect(reversed.input.scenario?.peers).toEqual([]);
    expect(forward.result.valuation).toBeNull();
    expect(reversed.result.valuation).toBeNull();
  });

  it("prioritizes previously verified same-SIC issuers outside the first 24 directory candidates", async () => {
    const entries = [...Array.from({ length: 24 }, (_, i) => ({ symbol: `AAA${String(i).padStart(2, "0")}`,
      industry: "Equipment", sector: "Technology", sic: 3571 })),
      ...["ZZXA", "ZZXB", "ZZXC"].map(symbol => ({ symbol, industry: "Software", sector: "Technology" }))];
    const knownSymbols = ["ZZXA", "ZZXB", "ZZXC"];
    const forward = await collect(entries, { knownSymbols }), reverse = await collect([...entries].reverse(), { knownSymbols });
    expect(forward.result.valuation?.peers.map(peer => peer.symbol)).toEqual(knownSymbols);
    expect(reverse.result.valuation?.peers.map(peer => peer.symbol)).toEqual(knownSymbols);
  });

  it("fills missing registration only from an official filing and archives that evidence", async () => {
    const { input } = await collect([], { coverState: "DE" });
    expect(input.scenario).toBeDefined();
    expect(input.sources.find(source => source.id.endsWith(":incorporation")))
      .toMatchObject({ url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/annual.htm", publishedAt: "2026-03-01T23:59:59.000Z" });
    expect((await collect([], { coverState: "Cayman Islands" })).input.scenario).toBeUndefined();
  });
});
