import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fundInputsFromSecFacts, type SecFact, type SecFactsFile } from "@/lib/data-sources/secFacts";

const point = (start: string | undefined, end: string, val: number, extra: Partial<SecFact> = {}): SecFact => ({
  start, end, val, form: "10-Q", filed: end === "2024-03-31" ? "2024-05-01" : "2024-02-01", fy: 2024, fp: "Q1", ...extra,
});
function fixture(): SecFactsFile {
  const rev = [point("2023-01-01", "2023-03-31", 100), point("2023-04-01", "2023-06-30", 200),
    point("2023-07-01", "2023-09-30", 300), point("2023-01-01", "2023-09-30", 600),
    point("2023-01-01", "2023-12-31", 1000, { form: "10-K", fp: "FY" }), point("2024-01-01", "2024-03-31", 200)];
  const scaled = (factor: number, last: number) => rev.map((r, i) => ({ ...r, val: i === rev.length - 1 ? last : r.val! * factor }));
  return { facts: { "us-gaap": {
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: rev } },
    GrossProfit: { units: { USD: scaled(.4, 100) } },
    NetIncomeLoss: { units: { USD: scaled(.1, 30) } },
    EarningsPerShareDiluted: { units: { "USD/shares": [point("2023-01-01", "2023-03-31", 1), point("2024-01-01", "2024-03-31", 1.5)] } },
    StockholdersEquity: { units: { USD: [point(undefined, "2024-03-31", 500)] } },
    LongTermDebtNoncurrent: { units: { USD: [point(undefined, "2024-03-31", 200)] } },
    LongTermDebtCurrent: { units: { USD: [point(undefined, "2024-03-31", 50)] } },
    ShortTermBorrowings: { units: { USD: [point(undefined, "2024-03-31", 20)] } },
  } } };
}
const calc = (facts: SecFactsFile) => fundInputsFromSecFacts(facts, "2024-05-02");

describe("SEC 报告期取数", () => {
  it("按真实期间匹配同比，补 Q4，并使用连续四季净利计算 ROE", () => {
    const result = calc(fixture());
    expect(result.epsYoy).toBe(.5); // 相同 fy/fp 也不能匹配成同一期。
    expect(result.revYoy).toBe(1);
    expect(result.gmTtm).toBeCloseTo(460 / 1100, 10);
    expect(result.roe).toBeCloseTo(120 / 500, 10);
    expect(result.debtEquity).toBe(.54);
  });

  it("重复披露、其他货币、备用标签不能重复相加或挤掉稀释 EPS", () => {
    const data = fixture(), gaap = data.facts!["us-gaap"]!;
    const expected = calc(data);
    for (const [name, fact] of Object.entries(gaap)) {
      const unit = name === "EarningsPerShareDiluted" ? "USD/shares" : "USD";
      const rows = fact.units![unit];
      fact.units![unit] = rows.flatMap((r) => [r, { ...r, filed: "2024-05-02", fp: "FY" }, r]);
      fact.units!.EUR = rows.map((r) => ({ ...r, val: 999999 }));
    }
    gaap.EarningsPerShareBasic = { units: { "USD/shares": [point("2024-01-01", "2024-03-31", 99)] } };
    gaap.Revenues = { units: { USD: [point("2024-01-01", "2024-03-31", 999)] } };
    expect(calc(data)).toEqual(expected);
  });

  it("只采用截止日已披露的修订，未来财报不能改变过去的结果", () => {
    const data = fixture(), eps = data.facts!["us-gaap"]!.EarningsPerShareDiluted.units!["USD/shares"];
    eps.push(point("2024-01-01", "2024-03-31", 2, { filed: "2024-06-01", form: "10-Q/A" }));
    expect(calc(data).epsYoy).toBe(.5);
    expect(fundInputsFromSecFacts(data, "2024-06-01").epsYoy).toBe(1);
    eps.push(point("2024-04-01", "2024-06-30", 10, { filed: "2024-08-01" }));
    expect(calc(data).epsYoy).toBe(.5);
  });

  it("跨季有缺口时不伪造 TTM，也不把 FY 文件里的单季值当全年", () => {
    const data = fixture();
    for (const key of ["GrossProfit", "NetIncomeLoss"]) {
      const fact = data.facts!["us-gaap"]![key];
      fact.units!.USD = fact.units!.USD.filter((r) => r.end !== "2023-06-30" && r.end !== "2023-12-31").map((r) => ({ ...r, fp: "FY" }));
    }
    expect(calc(data).roe).toBeNull();
    expect(calc(data).gmTtm).toBeNull();
  });

  it("缺债务数据是未知，明确披露的零债务才按零处理", () => {
    const data = fixture(), gaap = data.facts!["us-gaap"]!;
    delete gaap.ShortTermBorrowings;
    expect(calc(data).debtEquity).toBeNull();
    gaap.DebtCurrent = { units: { USD: [point(undefined, "2024-03-31", 0)] } };
    gaap.LongTermDebtNoncurrent.units!.USD[0].val = 0;
    expect(calc(data).debtEquity).toBe(0);
    // 债务和权益的日期不同，不能拼成一个有效比率。
    gaap.DebtCurrent.units!.USD[0].end = "2023-12-31";
    expect(calc(data).debtEquity).toBeNull();
  });

  it("长期债总额已包含一年内到期部分，不能重复计入", () => {
    const data = fixture(), gaap = data.facts!["us-gaap"]!;
    gaap.LongTermDebt = { units: { USD: [point(undefined, "2024-03-31", 250)] } };
    expect(calc(data).debtEquity).toBe(.54);
    delete gaap.LongTermDebtNoncurrent;
    expect(calc(data).debtEquity).toBe(.54);
  });

  it("财报未披露、IFRS 或非正权益不生成虚假的完整评分", () => {
    expect(calc({})).toEqual({ epsYoy: null, revYoy: null, gmTtm: null, roe: null, debtEquity: null });
    const data = fixture();
    data.facts!["us-gaap"]!.StockholdersEquity.units!.USD[0].val = -1;
    expect(calc(data).roe).toBeNull();
    expect(calc(data).debtEquity).toBeNull();
  });

  it("年度 EPS 同比不被 Q3 冒充，也不把负基数扭亏硬算成增长率", () => {
    const data = fixture();
    data.facts!["us-gaap"]!.EarningsPerShareDiluted.units!["USD/shares"] = [
      point("2022-01-01", "2022-12-31", 3, { form: "10-K", fp: "FY" }),
      point("2023-07-01", "2023-09-30", 20),
      point("2023-01-01", "2023-12-31", 6, { form: "10-K", fp: "FY" }),
    ];
    expect(calc(data).epsYoy).toBe(1);
    data.facts!["us-gaap"]!.EarningsPerShareDiluted.units!["USD/shares"][0].val = -3;
    expect(calc(data).epsYoy).toBeNull();
  });
});

it("AAPL 2024-05-03 真实财报：同比、TTM 和债务逐项对账", () => {
  const facts: SecFactsFile = JSON.parse(readFileSync(new URL("./fixtures/sec-aapl-2024.json", import.meta.url), "utf8"));
  const result = fundInputsFromSecFacts(facts, "2024-05-03");
  expect(result.epsYoy).toBeCloseTo(1.53 / 1.52 - 1, 10);
  expect(result.revYoy).toBeCloseTo(90753 / 94836 - 1, 10);
  // 年度 + 本年累计 - 上年同期累计，独立核对四季合计。
  expect(result.gmTtm).toBeCloseTo((169148 + 97126 - 92308) / (383285 + 210328 - 211990), 10);
  expect(result.roe).toBeCloseTo((96995 + 57552 - 54158) / 74194, 10);
  expect(result.debtEquity).toBeCloseTo((91831 + 10762 + 1997) / 74194, 10);
});

it("BE 2022 年累计净利修订优先于未同步修订的旧单季", () => {
  const facts: SecFactsFile = JSON.parse(readFileSync(new URL("./fixtures/sec-be-2022.json", import.meta.url), "utf8"));
  const input = fundInputsFromSecFacts(facts, "2022-11-30");
  expect(input.roe).toBeCloseTo((-164445 - 254536 + 131131) / 172892, 10);
});
