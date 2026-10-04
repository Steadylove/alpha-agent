import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSecFundamentalProvider } from "@/lib/fundamental/secProvider";

type Fact = { start?: string; end: string; val: number; filed: string; accn: string; form: string };
type Fixture = {
  symbol: string; expectedPeriodEnd: string;
  companyfacts: { cik: number; facts: { "us-gaap": Record<string, { units: Record<string, Fact[]> }> } };
  submissions: Record<string, unknown>;
};
const { cases } = JSON.parse(readFileSync(new URL("./fixtures/sec-cash-dividends-2026.json", import.meta.url), "utf8")) as { cases: Fixture[] };
const now = new Date("2026-10-04T12:00:00.000Z");

function collect(fixture: Fixture) {
  // All requests are fulfilled from trimmed SEC responses; no real contact identity is loaded.
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input), cik = String(fixture.companyfacts.cik).padStart(10, "0");
    if (url === "https://www.sec.gov/files/company_tickers.json") return Response.json({ "0": { ticker: fixture.symbol, cik_str: fixture.companyfacts.cik } });
    if (url === `https://data.sec.gov/submissions/CIK${cik}.json`) return Response.json(fixture.submissions);
    if (url === `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`) return Response.json(fixture.companyfacts);
    throw new Error("Unexpected request in offline SEC fixture test");
  }) as typeof fetch;
  return createSecFundamentalProvider({ userAgent: "Offline fixture research@institution.org", now,
    fetchFn, quoteReader: () => null, requestIntervalMs: 0 })(fixture.symbol);
}

describe("SEC issuer and capital-event evidence", () => {
  it.each(cases)("does not mistake $symbol's actual per-share cash dividends for a stock split", async fixture => {
    const input = await collect(structuredClone(fixture));
    expect(input.scenario?.current.periodEnd).toBe(fixture.expectedPeriodEnd);
    expect(input.scenario?.current.dilutedShares).toBeGreaterThan(0);
    expect(input.warnings.join(" ")).not.toContain("拆股相关披露");
  });

  it("still rejects a genuine non-unit split ratio reported after the share-count period", async () => {
    const fixture = structuredClone(cases[0]);
    fixture.companyfacts.facts["us-gaap"].StockholdersEquityNoteStockSplitConversionRatio1 = {
      units: { pure: [{ end: "2026-08-01", filed: "2026-08-15", val: 4, accn: "0000320193-26-999999", form: "8-K" }] },
    };
    const input = await collect(fixture);
    expect(input.scenario).toBeUndefined();
    expect(input.warnings.join(" ")).toContain("拆股相关披露");
  });

  it("still rejects stock dividends measured in shares, including one additional share", async () => {
    const fixture = structuredClone(cases[0]);
    fixture.companyfacts.facts["us-gaap"].CommonStockSharesIssuedInStockDividend = {
      units: { shares: [{ end: "2026-08-01", filed: "2026-08-15", val: 1, accn: "0000320193-26-999999", form: "8-K" }] },
    };
    const input = await collect(fixture);
    expect(input.scenario).toBeUndefined();
    expect(input.warnings.join(" ")).toContain("拆股相关披露");
  });

  it("does not classify a debt conversion ratio as evidence of a common-stock split", async () => {
    const fixture = structuredClone(cases[0]);
    fixture.companyfacts.facts["us-gaap"].DebtInstrumentConvertibleConversionRatio = {
      units: { pure: [{ end: "2026-08-01", filed: "2026-08-15", val: 1.5, accn: "0000320193-26-999999", form: "8-K" }] },
    };
    expect((await collect(fixture)).scenario?.current.periodEnd).toBe(fixture.expectedPeriodEnd);
  });

  it("keeps missing incorporation metadata unavailable instead of inferring domestic identity", async () => {
    const fixture = structuredClone(cases[0]);
    fixture.submissions.stateOfIncorporation = "";
    const input = await collect(fixture);
    expect(input.scenario).toBeUndefined();
    expect(input.warnings.join(" ")).toContain("美国国内注册身份无法确认");
  });
});
