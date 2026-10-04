import { describe, expect, it } from "vitest";
import { parseSecIncorporationState, selectSecIncorporationFiling } from "../src/lib/fundamental/secIssuerEvidence";

const today = "2026-10-04";
const cik = "0001341439";
const meta = () => ({
  cik: "1341439", entityType: "operating", stateOfIncorporation: "",
  filings: { recent: {
    form: ["10-Q", "10-K", "10-K"],
    filingDate: ["2026-09-11", "2026-06-22", "2025-06-20"],
    accessionNumber: ["0001193125-26-389274", "0001193125-26-277521", "0001193125-25-144000"],
    primaryDocument: ["orcl-20260831.htm", "orcl-20260531.htm", "orcl-20250531.htm"],
  } },
});
const fact = (text: string, attributes = "") => `<ix:nonNumeric name="dei:EntityIncorporationStateCountryCode" contextRef="c-1" ${attributes}>${text}</ix:nonNumeric>`;

describe("SEC annual filing identity evidence", () => {
  it("selects the latest disclosed annual filing using the issuer CIK, including a filing-agent accession", () => {
    expect(selectSecIncorporationFiling(meta(), cik, today)).toEqual({
      url: "https://www.sec.gov/Archives/edgar/data/1341439/000119312526277521/orcl-20260531.htm",
      accn: "0001193125-26-277521", filedAt: "2026-06-22",
    });
  });

  it("does not use a future or same-day annual report, or treat a 10-Q as an annual report", () => {
    const value = meta();
    value.filings.recent.filingDate[1] = today;
    expect(selectSecIncorporationFiling(value, cik, today)?.filedAt).toBe("2025-06-20");
    value.filings.recent.filingDate[1] = "2026-11-01";
    expect(selectSecIncorporationFiling(value, cik, today)?.filedAt).toBe("2025-06-20");
    value.filings.recent.form = ["10-Q", "10-Q", "10-Q"];
    expect(selectSecIncorporationFiling(value, cik, today)).toBeNull();
  });

  it.each(["DE", "E9", "X0"])("does not replace a populated incorporation state (%s)", state => {
    const value = meta(); value.stateOfIncorporation = state;
    expect(selectSecIncorporationFiling(value, cik, today)).toBeNull();
  });

  it("rejects an unverified issuer and known foreign reporting forms", () => {
    expect(selectSecIncorporationFiling(meta(), "0001321655", today)).toBeNull();
    const value = meta(); value.entityType = "other";
    expect(selectSecIncorporationFiling(value, cik, today)).toBeNull();
    value.entityType = "operating"; value.filings.recent.form[0] = "20-F";
    expect(selectSecIncorporationFiling(value, cik, today)).toBeNull();
  });

  it.each(["../../other.htm", "https://other.test/x.htm", "report.htm?x=1", "report%2ehtm", "report.xml", "report..htm"])("rejects an unsafe or non-HTML primary document: %s", name => {
    const value = meta(); value.filings.recent.primaryDocument[1] = name;
    expect(selectSecIncorporationFiling(value, cik, today)).toBeNull();
  });

  it("does not silently fall back to an older annual report when the latest document metadata is missing", () => {
    const value = meta(); value.filings.recent.primaryDocument[1] = "";
    expect(selectSecIncorporationFiling(value, cik, today)).toBeNull();
    value.filings.recent.primaryDocument[1] = "orcl-20260531.htm";
    value.filings.recent.accessionNumber[1] = "invalid";
    expect(selectSecIncorporationFiling(value, cik, today)).toBeNull();
  });

  it("reads the two exact incorporation facts captured from official ORCL and PLTR annual reports", () => {
    // Captured 2026-10-04 from ORCL accession 0001193125-26-277521 and PLTR 0001321655-26-000011.
    const oracle = '<ix:nonNumeric id="F_ff75db3a-0b8b-40f3-8bc7-8f5035c886d3" contextRef="C_24317829-d237-4c29-bae3-2e46dd1ae625" name="dei:EntityIncorporationStateCountryCode" format="ixt-sec:stateprovnameen"><span style="color:#000000;white-space:pre-wrap;font-weight:bold;font-kerning:none;min-width:fit-content;">Delaware</span></ix:nonNumeric>';
    const palantir = '<ix:nonNumeric contextRef="c-1" name="dei:EntityIncorporationStateCountryCode" format="ixt-sec:stateprovnameen" id="f-8">Delaware</ix:nonNumeric>';
    expect(parseSecIncorporationState(oracle)).toBe("DE");
    expect(parseSecIncorporationState(palantir)).toBe("DE");
  });

  it("decodes escaped values and accepts exact US state codes or names", () => {
    expect(parseSecIncorporationState(fact("&#68;&#x45;"))).toBe("DE");
    expect(parseSecIncorporationState(fact("New&nbsp;York", 'format="ixt-sec:stateprovnameen"'))).toBe("NY");
    expect(parseSecIncorporationState(fact("District of Columbia"))).toBe("DC");
    expect(parseSecIncorporationState("<ix:nonNumeric contextRef='x' name='dei&#58;EntityIncorporationStateCountryCode'>CA</ix:nonNumeric>")).toBe("CA");
  });

  it("rejects absent, foreign, conflicting, incomplete, or unsupported facts", () => {
    for (const html of ["<p>Registered in Delaware</p>", fact("E9"), fact("Cayman Islands"),
      fact("DE") + fact("NV"), fact("DE") + fact("E9"), fact("DE", 'continuedAt="next"'),
      fact("DE", 'xsi:nil="true"'), fact("DE", 'format="custom:guess"'), fact("DE", 'format="custom:stateprovnameen"'), fact("New&unknown;York"),
      fact("DE", 'name="dei:DifferentConcept"')]) expect(parseSecIncorporationState(html)).toBeNull();
    expect(parseSecIncorporationState(fact("DE") + fact("Delaware"))).toBe("DE");
  });

  it("ignores commented and escaped pseudo-facts, and does not execute scripts or follow continuation references", () => {
    expect(parseSecIncorporationState(`<!-- ${fact("DE")} -->`)).toBeNull();
    expect(parseSecIncorporationState(`&lt;ix:nonNumeric name=&quot;dei:EntityIncorporationStateCountryCode&quot;&gt;DE&lt;/ix:nonNumeric&gt;`)).toBeNull();
    expect(parseSecIncorporationState(`<script>${fact("DE")}</script>`)).toBeNull();
  });

  it("enforces the 12 MiB parsing budget on both plain and multi-byte HTML", () => {
    expect(parseSecIncorporationState(" ".repeat(12 * 1024 * 1024) + fact("DE"))).toBeNull();
    expect(parseSecIncorporationState("中".repeat(5 * 1024 * 1024) + fact("DE"))).toBeNull();
  });
});
