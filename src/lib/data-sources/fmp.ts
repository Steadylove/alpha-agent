export type FundamentalSnapshot = {
  symbol: string;
  revenueGrowth: number | null;
  grossMargin: number | null;
  epsRevisionRate: number | null;
};

type FmpIncomeRow = {
  date?: string;
  revenue?: number;
  grossProfit?: number;
  eps?: number;
};

type FmpGradeRow = {
  date?: string;
  action?: "upgrade" | "downgrade" | "maintain" | "initiate" | string;
};

const FMP_BASE = "https://financialmodelingprep.com/stable";

const emptyFundamentals = (symbol: string): FundamentalSnapshot => ({
  symbol,
  revenueGrowth: null,
  grossMargin: null,
  epsRevisionRate: null,
});

const safeFetch = async (url: string): Promise<Response | null> => {
  try {
    return await fetch(url, { next: { revalidate: 24 * 60 * 60 } });
  } catch {
    return null;
  }
};

async function fetchIncomeSnapshot(
  symbol: string,
  apiKey: string,
): Promise<Pick<FundamentalSnapshot, "revenueGrowth" | "grossMargin"> | null> {
  const url = `${FMP_BASE}/income-statement?symbol=${symbol}&period=quarter&limit=5&apikey=${apiKey}`;
  const response = await safeFetch(url);
  if (!response || !response.ok) return null;

  const rows = (await response.json()) as FmpIncomeRow[];
  const latest = rows[0];
  const previousYearQuarter = rows[4];
  if (!latest || latest.revenue == null || latest.revenue === 0) return null;

  const revenueGrowth =
    previousYearQuarter?.revenue
      ? (latest.revenue - previousYearQuarter.revenue) / previousYearQuarter.revenue
      : null;

  const grossMargin =
    latest.grossProfit != null ? latest.grossProfit / latest.revenue : null;

  return { revenueGrowth, grossMargin };
}

/**
 * EPS Revision 代理：过去 30 天内 (upgrades - downgrades) / (upgrades + downgrades)
 * 直接反映卖方分析师上调/下调预期的净情绪
 * 范围：-1 (全部下调) ~ +1 (全部上调)
 */
async function fetchAnalystRevisionProxy(
  symbol: string,
  apiKey: string,
): Promise<number | null> {
  const url = `${FMP_BASE}/grades?symbol=${symbol}&apikey=${apiKey}`;
  const response = await safeFetch(url);
  if (!response || !response.ok) return null;

  const rows = (await response.json()) as FmpGradeRow[];
  if (rows.length === 0) return null;

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = rows.filter((row) => {
    if (!row.date) return false;
    return new Date(row.date).getTime() >= cutoff;
  });
  if (recent.length === 0) return null;

  const upgrades = recent.filter((row) => row.action === "upgrade").length;
  const downgrades = recent.filter((row) => row.action === "downgrade").length;
  const total = upgrades + downgrades;
  if (total === 0) return 0;

  return (upgrades - downgrades) / total;
}

export async function fetchFmpFundamentals(symbol: string): Promise<FundamentalSnapshot> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return emptyFundamentals(symbol);

  const [income, epsRevisionRate] = await Promise.all([
    fetchIncomeSnapshot(symbol, apiKey),
    fetchAnalystRevisionProxy(symbol, apiKey),
  ]);

  return {
    symbol,
    revenueGrowth: income?.revenueGrowth ?? null,
    grossMargin: income?.grossMargin ?? null,
    epsRevisionRate,
  };
}
