import type { FundScoreInputs } from "@/lib/scoring/fundScore";

const TICKER_URL = "https://www.sec.gov/files/company_tickers.json";
const factsUrl = (cik: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
const DAY = 86_400_000;
const FLOW = {
  eps: ["EarningsPerShareDiluted", "EarningsPerShareBasic"],
  rev: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
  gp: ["GrossProfit"],
  ni: ["NetIncomeLoss"],
} as const;

export type SecFact = {
  start?: string;
  end?: string;
  val?: number;
  form?: string;
  fp?: string;
  fy?: number;
  filed?: string;
  accn?: string;
};
export type SecFactsFile = {
  facts?: { "us-gaap"?: Record<string, { units?: Record<string, SecFact[]> }> };
};
type Point = SecFact & { end: string; val: number; filed: string };
type FlowSeries = { rows: Point[]; quarters: Point[]; years: Point[] };
export type SecFundInputs = Omit<FundScoreInputs, "dist52w">;

let tickerMap: Map<string, string> | null = null;
const normalizeTicker = (symbol: string) => symbol.trim().toUpperCase().replace(/\./g, "-");

async function secJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(8_000);
  const response = await fetch(url, {
    headers: { "user-agent": process.env.SEC_USER_AGENT || "alpha-agent luqiang@dayfold.ai", accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`SEC ${response.status}`);
  return (await response.json()) as T;
}

export async function secCikOf(symbol: string, signal?: AbortSignal): Promise<string | null> {
  if (!tickerMap) {
    const raw = await secJson<Record<string, { ticker: string; cik_str: number }>>(TICKER_URL, signal);
    tickerMap = new Map(Object.values(raw).map((row) => [normalizeTicker(row.ticker), String(row.cik_str).padStart(10, "0")]));
  }
  return tickerMap.get(normalizeTicker(symbol)) ?? null;
}

const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / DAY;
const duration = (row: Point) => row.start ? days(row.start, row.end) : 0;
const isQuarter = (n: number) => n >= 70 && n <= 105;
const isYear = (n: number) => n >= 350 && n <= 380;
const newer = (a: Point, b: Point) => a.filed.localeCompare(b.filed) || (a.accn ?? "").localeCompare(b.accn ?? "");

/** 固定概念和单位；同报告期只保留截止日已披露的最新修订。fy/fp 是申报文件属性，不能用于匹配同比期间。 */
function concept(facts: SecFactsFile, name: string, unit: string, asOf: string): Point[] {
  const unique = new Map<string, Point>();
  for (const row of facts.facts?.["us-gaap"]?.[name]?.units?.[unit] ?? []) {
    if (typeof row.val !== "number" || !Number.isFinite(row.val) || !row.end || !row.filed) continue;
    if (!/^10-[QK](\/A)?$/.test(row.form ?? "") || row.filed > asOf || row.end > asOf) continue;
    if (!Number.isFinite(Date.parse(row.end)) || !Number.isFinite(Date.parse(row.filed))) continue;
    const key = `${row.start ?? ""}/${row.end}`;
    const prev = unique.get(key);
    if (!prev || newer(row as Point, prev) > 0) unique.set(key, row as Point);
  }
  return [...unique.values()].sort((a, b) => a.end.localeCompare(b.end) || newer(a, b));
}

function quartersOf(rows: Point[], additive: boolean): Point[] {
  const quarters = new Map<string, Point>();
  for (const row of rows.filter((r) => isQuarter(duration(r)))) {
    const old = quarters.get(row.end);
    if (!old || newer(row, old) > 0) quarters.set(row.end, row);
  }
  if (additive) {
    // Q2/Q3/Q4 常只披露累计值。只能用同一财年起点的累计差，不能把 EPS 直接相减。
    for (const row of rows) {
      if (!row.start || duration(row) <= 105 || duration(row) > 380 || quarters.has(row.end)) continue;
      const prior = rows.filter((p) => p.start === row.start && isQuarter(days(p.end, row.end))).at(-1);
      if (!prior) continue;
      quarters.set(row.end, { ...row, start: new Date(Date.parse(prior.end) + DAY).toISOString().slice(0, 10),
        val: row.val - prior.val, filed: row.filed > prior.filed ? row.filed : prior.filed });
    }
  }
  return [...quarters.values()].sort((a, b) => a.end.localeCompare(b.end));
}

function flow(facts: SecFactsFile, names: readonly string[], asOf: string, eps = false): FlowSeries {
  // 不混合稀释/基本 EPS 或多套营收标签。选覆盖最新期间的概念，同期按标签优先级。
  const candidates = names.map((name) => {
    const rows = concept(facts, name, eps ? "USD/shares" : "USD", asOf).filter((r) => r.start && duration(r) >= 70 && duration(r) <= 380);
    return { rows, quarters: quartersOf(rows, !eps), years: rows.filter((r) => isYear(duration(r))) };
  });
  candidates.sort((a, b) => (b.rows.at(-1)?.end ?? "").localeCompare(a.rows.at(-1)?.end ?? ""));
  return candidates[0] ?? { rows: [], quarters: [], years: [] };
}

function yoy(series: FlowSeries): number | null {
  // 最新年度没有单季 EPS 时用年度同比；不以年度 EPS 减前三季来伪造 Q4。
  const q = series.quarters.at(-1), y = series.years.at(-1);
  const rows = y && (!q || y.end > q.end) ? series.years : series.quarters;
  const latest = rows.at(-1);
  if (!latest?.start || latest.end !== series.rows.at(-1)?.end) return null;
  const prior = rows.filter((p) => p.start && Math.abs(days(p.end, latest.end) - 365) <= 14 &&
    Math.abs(duration(p) - duration(latest)) <= 14).at(-1);
  return prior && prior.val > 0 ? (latest.val - prior.val) / prior.val : null;
}

function ttm(series: FlowSeries): Point | null {
  const end = series.rows.at(-1)?.end;
  const annual = series.years.filter((r) => r.end === end).at(-1);
  if (annual) return annual;
  // 最新累计值可能修订了先前季度，却没有重新披露那个单季（如 BE 2022 Q2）。
  // 优先用 年度 + 当年累计 - 上年同期累计，避免把未修订的旧单季混进 TTM。
  const previousYear = series.years.filter((r) => end && r.end < end).at(-1);
  if (previousYear && end) {
    const start = new Date(Date.parse(previousYear.end) + DAY).toISOString().slice(0, 10);
    const current = series.rows.find((r) => r.start === start && r.end === end);
    const prior = series.rows.filter((r) => r.start === previousYear.start && Math.abs(days(r.end, end) - 365) <= 14).at(-1);
    if (current && prior && Math.abs(duration(current) - duration(prior)) <= 14) {
      return { ...current, start: new Date(Date.parse(prior.end) + DAY).toISOString().slice(0, 10),
        val: previousYear.val + current.val - prior.val };
    }
  }
  const q = series.quarters.slice(-4);
  if (q.length !== 4 || q[3].end !== end || !q[0].start || !isYear(days(q[0].start, q[3].end))) return null;
  if (q.some((row, i) => i > 0 && (!row.start || days(q[i - 1].end, row.start) !== 1))) return null;
  return { ...q[3], start: q[0].start, val: q.reduce((sum, r) => sum + r.val, 0) };
}

function instant(facts: SecFactsFile, names: readonly string[], asOf: string, end?: string): Point | null {
  const candidates = names.map((name) => concept(facts, name, "USD", asOf).filter((r) => !r.start && (!end || r.end === end)).at(-1));
  return candidates.filter((r): r is Point => Boolean(r)).sort((a, b) => b.end.localeCompare(a.end))[0] ?? null;
}

function debtAt(facts: SecFactsFile, asOf: string, end: string): number | null {
  const get = (names: string[]) => instant(facts, names, asOf, end)?.val ?? null;
  const total = get(["LongTermDebtAndShortTermBorrowings"]);
  if (total != null) return total;
  const noncurrent = get(["LongTermDebtNoncurrent"]);
  const current = get(["DebtCurrent"]); // 已含一年内到期的长期债，不能再加一次。
  if (noncurrent != null && current != null) return noncurrent + current;
  const short = get(["ShortTermBorrowings", "CommercialPaper"]);
  const longCurrent = get(["LongTermDebtCurrent"]);
  if (noncurrent != null && longCurrent != null && short != null) return noncurrent + longCurrent + short;
  const longTotal = get(["LongTermDebt"]); // 已含 LongTermDebtCurrent，部分公司只披露这个合计。
  if (longTotal != null && short != null) return longTotal + short;
  return null; // 没披露不等于零；宁可缺维，也不凭空给债务风险满分。
}

/** 纯函数，可按历史披露日回放；不使用截止日之后的财报或修订。 */
export function fundInputsFromSecFacts(facts: SecFactsFile, asOf = new Date().toISOString().slice(0, 10)): SecFundInputs {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || !Number.isFinite(Date.parse(asOf))) throw new Error("Invalid SEC asOf date");
  const eps = flow(facts, FLOW.eps, asOf, true);
  const rev = flow(facts, FLOW.rev, asOf);
  const gp = ttm(flow(facts, FLOW.gp, asOf));
  const revenue = ttm(rev);
  const income = ttm(flow(facts, FLOW.ni, asOf));
  const equity = instant(facts, ["StockholdersEquity"], asOf);
  const debt = equity ? debtAt(facts, asOf, equity.end) : null;
  return {
    epsYoy: yoy(eps),
    revYoy: yoy(rev),
    roe: income && equity && income.end === equity.end && equity.val > 0 ? income.val / equity.val : null,
    gmTtm: gp && revenue && gp.end === revenue.end && revenue.val > 0 ? gp.val / revenue.val : null,
    debtEquity: debt != null && debt >= 0 && equity && equity.val > 0 ? debt / equity.val : null,
  };
}

export async function fetchSecFundInputs(symbol: string, options: { asOf?: string; signal?: AbortSignal } = {}): Promise<SecFundInputs | null> {
  const cik = await secCikOf(symbol, options.signal);
  if (!cik) return null;
  return fundInputsFromSecFacts(await secJson<SecFactsFile>(factsUrl(cik), options.signal), options.asOf);
}
