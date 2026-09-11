import type { FundScoreInputs } from "@/lib/scoring/fundScore";

const UA = "alpha-agent luqiang@dayfold.ai";
const TICKER_URL = "https://www.sec.gov/files/company_tickers.json";
const factsUrl = (cik: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

const FLOW = {
  eps: ["EarningsPerShareDiluted", "EarningsPerShareBasic"],
  rev: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
  gp: ["GrossProfit"],
  ni: ["NetIncomeLoss"],
} as const;

const INSTANT = {
  equity: ["StockholdersEquity"],
  ltd: ["LongTermDebt", "LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"],
  std: ["DebtCurrent", "ShortTermBorrowings", "LongTermDebtCurrent"],
} as const;

type SecFact = {
  start?: string;
  end?: string;
  val?: number;
  form?: string;
  fp?: string;
  fy?: number;
};

type SecFactsFile = {
  facts?: { "us-gaap"?: Record<string, { units?: Record<string, SecFact[]> }> };
};

let tickerMap: Map<string, string> | null = null;

async function secJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!response.ok) throw new Error(`SEC ${response.status}`);
  return (await response.json()) as T;
}

export async function secCikOf(symbol: string): Promise<string | null> {
  if (!tickerMap) {
    const raw = await secJson<Record<string, { ticker: string; cik_str: number }>>(TICKER_URL);
    tickerMap = new Map(
      Object.values(raw).map((row) => [row.ticker.toUpperCase(), String(row.cik_str).padStart(10, "0")]),
    );
  }
  return tickerMap.get(symbol.toUpperCase()) ?? null;
}

function periodDays(row: SecFact): number | null {
  if (!row.start || !row.end) return null;
  return (Date.parse(row.end) - Date.parse(row.start)) / 86_400_000;
}

function collect(facts: SecFactsFile, names: readonly string[]): SecFact[] {
  const gaap = facts.facts?.["us-gaap"] ?? {};
  const rows: SecFact[] = [];
  for (const name of names) {
    for (const unit of Object.values(gaap[name]?.units ?? {})) {
      for (const row of unit) {
        if (row.val == null || !Number.isFinite(row.val) || !row.end) continue;
        if (row.form !== "10-Q" && row.form !== "10-K") continue;
        rows.push(row);
      }
    }
  }
  return rows;
}

function quarterly(rows: SecFact[]): SecFact[] {
  return rows
    .filter((row) => {
      const days = periodDays(row);
      return days != null && days >= 70 && days <= 100;
    })
    .sort((a, b) => a.end!.localeCompare(b.end!));
}

function annual(rows: SecFact[]): SecFact[] {
  return rows
    .filter((row) => {
      const days = periodDays(row);
      return row.fp === "FY" || (days != null && days >= 350 && days <= 380);
    })
    .sort((a, b) => a.end!.localeCompare(b.end!));
}

function latestInstant(rows: SecFact[]): SecFact | null {
  const instants = rows.filter((row) => !row.start).sort((a, b) => a.end!.localeCompare(b.end!));
  return instants.at(-1) ?? rows.sort((a, b) => a.end!.localeCompare(b.end!)).at(-1) ?? null;
}

function yoyOf(rows: SecFact[]): number | null {
  const latest = rows.at(-1);
  if (!latest) return null;
  const prior = [...rows].reverse().find((row) =>
    latest.fp && latest.fy != null
      ? row.fp === latest.fp && row.fy === latest.fy - 1
      : Math.abs(Date.parse(row.end!) - (Date.parse(latest.end!) - 365 * 86_400_000)) < 21 * 86_400_000,
  ) ?? null;
  if (!prior || prior.val == null || prior.val <= 0 || latest.val == null) return null;
  return (latest.val - prior.val) / prior.val;
}

function ttmSum(rows: SecFact[]): number | null {
  const last4 = rows.slice(-4);
  if (last4.length < 4) return null;
  return last4.reduce((sum, row) => sum + (row.val ?? 0), 0);
}

export async function fetchSecFundInputs(symbol: string): Promise<Omit<FundScoreInputs, "dist52w"> | null> {
  const cik = await secCikOf(symbol);
  if (!cik) return null;
  const facts = await secJson<SecFactsFile>(factsUrl(cik));
  const eps = quarterly(collect(facts, FLOW.eps));
  const rev = quarterly(collect(facts, FLOW.rev));
  const gp = quarterly(collect(facts, FLOW.gp));
  const niQ = quarterly(collect(facts, FLOW.ni));
  const niY = annual(collect(facts, FLOW.ni));
  const equity = latestInstant(collect(facts, INSTANT.equity));
  const ltd = latestInstant(collect(facts, INSTANT.ltd));
  const std = latestInstant(collect(facts, INSTANT.std));
  const gpTtm = ttmSum(gp);
  const revTtm = ttmSum(rev);
  const niFy = niY.at(-1)?.val;
  const niTtm = ttmSum(niQ);
  const roe =
    equity?.val && equity.val > 0
      ? ((niFy != null ? niFy : niTtm) ?? null) != null
        ? ((niFy ?? niTtm)! / equity.val)
        : null
      : null;
  const debt = (ltd?.val ?? 0) + (std?.val ?? 0);
  return {
    epsYoy: yoyOf(eps),
    revYoy: yoyOf(rev),
    roe,
    gmTtm: gpTtm != null && revTtm != null && revTtm > 0 ? gpTtm / revTtm : null,
    debtEquity: equity?.val && equity.val > 0 ? debt / equity.val : null,
  };
}
