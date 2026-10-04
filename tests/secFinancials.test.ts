import { describe, expect, it } from "vitest";
import { normalizeSecPeriods } from "../src/lib/fundamental/secFinancials";
import captured from "./fixtures/sec-financial-real-2026.json";

type Row = { start?: string; end: string; val: number; filed: string; accn: string; form: string };
type Sample = { cik: number; facts: { "us-gaap": Record<string, { units: Record<string, Row[]> }> } };
function sample(symbol: keyof typeof captured.companies): Sample {
  return structuredClone(captured.companies[symbol]) as Sample;
}
const normalize = (data: Sample) => normalizeSecPeriods(data, String(data.cik).padStart(10, "0"), "2026-10-04");

describe("SEC financial normalization against reduced public records", () => {
  it("recomputes NVDA TTM from independently checked original FY and YTD amounts", () => {
    const result = normalize(sample("NVDA"));
    // SEC FY2026 0001045810-26-000021 and Q2 0001045810-26-000075, USD.
    expect(result.current.netIncome).toBe(120_067_000_000 + 118_010_000_000 - 45_197_000_000);
    expect(result.current.revenue).toBe(215_938_000_000 + 177_837_000_000 - 90_805_000_000);
    expect(result.current.operatingCashFlow).toBe(102_718_000_000 + 74_421_000_000 - 42_779_000_000);
    expect(result.current.capex).toBe(6_042_000_000 + 4_434_000_000 - 3_122_000_000);
    expect(result.current.dilutedShares).toBe(24_285_000_000);
    expect(result.warnings.join(" ")).toContain("不是纯 PP&E");
  });

  it("uses Amazon fiscal anchors even when its 10-Q contains trailing twelve-month net income", () => {
    const data = sample("AMZN"), rows = data.facts["us-gaap"].NetIncomeLoss.units.USD;
    expect(rows.some(row => row.start === "2025-07-01" && row.end === "2026-06-30" && row.form === "10-Q")).toBe(true);
    const { current } = normalize(data);
    // FY2025 0001018724-26-000004, H1 comparisons 0001018724-26-000026.
    expect(current.revenue).toBe(716_924_000_000 + 382_125_000_000 - 323_369_000_000);
    expect(current.netIncome).toBe(77_670_000_000 + 92_902_000_000 - 35_291_000_000);
    expect(current.operatingCashFlow).toBe(139_514_000_000 + 71_419_000_000 - 49_530_000_000);
    expect(current.capex).toBe(131_819_000_000 + 98_411_000_000 - 57_202_000_000);
    expect(current.operatingCashFlow - current.capex).toBe(-11_625_000_000);
  });

  it("does not infer Microsoft Q4 diluted shares from separately reported annual and 9M averages", () => {
    const data = sample("MSFT"), shares = data.facts["us-gaap"].WeightedAverageNumberOfDilutedSharesOutstanding.units.shares;
    // These real reported averages are insufficient: dilution is not linear.
    expect(shares.find(row => row.start === "2025-07-01" && row.end === "2026-06-30")?.val).toBe(7_453_000_000);
    expect(shares.find(row => row.start === "2025-07-01" && row.end === "2026-03-31")?.val).toBe(7_457_000_000);
    expect(() => normalize(data)).toThrow(/稀释加权股数/);
  });

  it.each(["NetIncomeLoss", "WeightedAverageNumberOfDilutedSharesOutstanding"])("blocks a one-sided cross-filing Q4 restatement of %s", tag => {
    const data = sample("MSFT"), unit = tag === "NetIncomeLoss" ? "USD" : "shares", rows = data.facts["us-gaap"][tag].units[unit];
    const nine = rows.find(row => row.start === "2025-07-01" && row.end === "2026-03-31")!;
    rows.push({ ...nine, val: nine.val * 1.01, filed: "2026-09-01", accn: "0001193125-26-400001", form: "10-Q/A" });
    expect(() => normalize(data)).toThrow(/重述|稀释加权股数/);
  });

  it("distinguishes preferred dividend rates and already-reflected splits from later share events", () => {
    const google = sample("GOOG"), powell = sample("POWL");
    expect(google.facts["us-gaap"].PreferredStockDividendRatePercentage).toBeDefined();
    expect(normalize(google).current.netIncome).toBe(244_205_000_000);
    expect(normalize(powell).current.netIncome).toBe(190_857_000);
    google.facts["us-gaap"].StockholdersEquityNoteStockSplitConversionRatio1 = { units: { pure: [{ end: "2026-07-02", filed: "2026-07-10", accn: "0001652044-26-000099", form: "8-K", val: 2 }] } };
    expect(() => normalize(google)).toThrow(/拆股/);
  });

  it("derives Caterpillar parent income from consolidated income minus noncontrolling interests", () => {
    const { current, warnings } = normalize(sample("CAT"));
    expect(current.netIncome).toBe(10_844_000_000);
    expect(warnings.join(" ")).toContain("ProfitLoss−NetIncomeLossAttributableToNoncontrollingInterest");
  });

  it("does not reject complete reported GEV income because an unused identity differs by disclosed rounding", () => {
    const data = sample("GEV"), { current, warnings } = normalize(data);
    expect(current.netIncome).toBe(9_529_000_000);
    expect(warnings.join(" ")).not.toContain("净利缺失期间");
    data.facts["us-gaap"].NetIncomeLoss.units.USD = data.facts["us-gaap"].NetIncomeLoss.units.USD.filter(row => !(row.start === "2026-01-01" && row.end === "2026-06-30"));
    expect(() => normalize(data)).toThrow(/恒等式不一致/);
  });

  it("checks operating-income identity against any directly reported overlap", () => {
    const data = sample("NEM");
    expect(normalize(data).warnings.join(" ")).toContain("NonoperatingIncomeExpense");
    const income = data.facts["us-gaap"].IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest.units.USD[0];
    data.facts["us-gaap"].OperatingIncomeLoss = { units: { USD: [{ ...income, val: 1 }] } };
    expect(() => normalize(data)).toThrow(/营业利润/);
  });

  it("does not patch missing broad capital outflow with a different PP&E concept", () => {
    const data = sample("NVDA"), broad = data.facts["us-gaap"].PaymentsToAcquireProductiveAssets.units.USD;
    const missing = broad.find(row => row.start === "2026-01-26" && row.end === "2026-07-26")!;
    data.facts["us-gaap"].PaymentsToAcquireProductiveAssets.units.USD = broad.filter(row => row !== missing);
    data.facts["us-gaap"].PaymentsToAcquirePropertyPlantAndEquipment = { units: { USD: [missing] } };
    expect(() => normalize(data)).toThrow(/不能拼接/);
  });
});
