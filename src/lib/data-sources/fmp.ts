export type FundamentalSnapshot = {
  symbol: string;
  revenueGrowth: number | null;
  grossMargin: number | null;
  fcfMargin: number | null;
  roic: number | null;
  epsRevisionRate: number | null;
  gmDecliningStreak: number;
  sharesDilution12m: number | null;
  marketCap: number | null;
  adtv20d: number | null;
  reverseSplit12m: boolean;
  analystTargetPrice: number | null;
  moatScore: number | null; // Wave 3 · LLM 1-5 分
  moatReason: string | null; // Wave 3 · LLM 一句话打分依据
};

type FmpIncomeRow = {
  date?: string;
  revenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  weightedAverageShsOutDil?: number;
};

type FmpRatiosTtmRow = {
  grossProfitMarginTTM?: number;
  freeCashFlowMarginTTM?: number;
  returnOnInvestedCapitalTTM?: number;
};

type FmpGradeRow = {
  date?: string;
  action?: "upgrade" | "downgrade" | "maintain" | "initiate" | string;
};

type FmpPriceTargetRow = {
  targetConsensus?: number;
};

const FMP_BASE = "https://financialmodelingprep.com/stable";

export const emptyFundamentals = (symbol: string): FundamentalSnapshot => ({
  symbol,
  revenueGrowth: null,
  grossMargin: null,
  fcfMargin: null,
  roic: null,
  epsRevisionRate: null,
  gmDecliningStreak: 0,
  sharesDilution12m: null,
  marketCap: null,
  adtv20d: null,
  reverseSplit12m: false,
  analystTargetPrice: null,
  moatScore: null,
  moatReason: null,
});

const safeJson = async <T>(url: string): Promise<T | null> => {
  try {
    const response = await fetch(url, { next: { revalidate: 24 * 60 * 60 } });
    if (!response.ok) return null;
    const data = (await response.json()) as unknown;
    // FMP 免费额度触顶会返回 { "Error Message": "..." } 而非 array
    if (data && typeof data === "object" && !Array.isArray(data) && "Error Message" in data) {
      return null;
    }
    return data as T;
  } catch {
    return null;
  }
};

/**
 * 第 1 层：全量拉，每只 1 次调用（income-statement quarter × 6）
 * 覆盖：revenueGrowth + grossMargin + GM 环降条数 + shares dilution 12M
 */
export async function fetchFmpIncomeBasics(
  symbol: string,
): Promise<Partial<FundamentalSnapshot> | null> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return null;

  const rows = await safeJson<FmpIncomeRow[]>(
    `${FMP_BASE}/income-statement?symbol=${symbol}&period=quarter&limit=6&apikey=${apiKey}`,
  );
  if (!rows || rows.length === 0) return null;

  const latest = rows[0];
  const yoy = rows[4];
  if (!latest || latest.revenue == null || latest.revenue === 0) return null;

  const revenueGrowth = yoy?.revenue
    ? (latest.revenue - yoy.revenue) / yoy.revenue
    : null;
  const grossMargin =
    latest.grossProfit != null ? latest.grossProfit / latest.revenue : null;

  const sharesLatest = latest.weightedAverageShsOutDil;
  const sharesYoY = yoy?.weightedAverageShsOutDil;
  const sharesDilution12m =
    sharesLatest && sharesYoY && sharesYoY > 0
      ? (sharesLatest - sharesYoY) / sharesYoY
      : null;

  let gmDecliningStreak = 0;
  for (let i = 0; i < rows.length - 1; i += 1) {
    const cur = rows[i];
    const prev = rows[i + 1];
    if (
      cur.grossProfit == null ||
      cur.revenue == null ||
      cur.revenue === 0 ||
      prev.grossProfit == null ||
      prev.revenue == null ||
      prev.revenue === 0
    ) {
      break;
    }
    const gmCur = cur.grossProfit / cur.revenue;
    const gmPrev = prev.grossProfit / prev.revenue;
    if (gmCur < gmPrev) gmDecliningStreak += 1;
    else break;
  }

  return { revenueGrowth, grossMargin, gmDecliningStreak, sharesDilution12m };
}

/**
 * 第 2 层：Top N 深度，每只 3 次调用
 *   - ratios-ttm 拿 grossMargin TTM / fcfMargin TTM / ROIC TTM
 *   - grades 拿 30D upgrade/downgrade 净情绪
 *   - price-target-consensus 拿 12M 分析师共识价
 */
export async function fetchFmpDeepFundamentals(
  symbol: string,
): Promise<Partial<FundamentalSnapshot> | null> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return null;

  const [ratios, grades, target] = await Promise.all([
    safeJson<FmpRatiosTtmRow[]>(
      `${FMP_BASE}/ratios-ttm?symbol=${symbol}&apikey=${apiKey}`,
    ),
    safeJson<FmpGradeRow[]>(`${FMP_BASE}/grades?symbol=${symbol}&apikey=${apiKey}`),
    safeJson<FmpPriceTargetRow>(
      `${FMP_BASE}/price-target-consensus?symbol=${symbol}&apikey=${apiKey}`,
    ),
  ]);

  const r = ratios?.[0];
  const roic = r?.returnOnInvestedCapitalTTM ?? null;
  const fcfMargin = r?.freeCashFlowMarginTTM ?? null;

  let epsRevisionRate: number | null = null;
  if (grades && grades.length > 0) {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = grades.filter((row) => {
      if (!row.date) return false;
      return new Date(row.date).getTime() >= cutoff;
    });
    if (recent.length > 0) {
      const upgrades = recent.filter((r) => r.action === "upgrade").length;
      const downgrades = recent.filter((r) => r.action === "downgrade").length;
      const total = upgrades + downgrades;
      epsRevisionRate = total === 0 ? 0 : (upgrades - downgrades) / total;
    }
  }

  return {
    roic,
    fcfMargin,
    epsRevisionRate,
    analystTargetPrice: target?.targetConsensus ?? null,
  };
}

/**
 * @deprecated Wave 1 分层策略后已被 fetchFmpIncomeBasics + fetchFmpDeepFundamentals 替代
 * 保留是为了兼容旧 API 路由；新代码请勿使用
 */
export async function fetchFmpFundamentals(symbol: string): Promise<FundamentalSnapshot> {
  const basics = await fetchFmpIncomeBasics(symbol);
  const deep = await fetchFmpDeepFundamentals(symbol);
  return { ...emptyFundamentals(symbol), ...basics, ...deep };
}

/**
 * 12M 估值引擎要的基本面输入。
 *
 * 对应 MarketCompass Pine 第 9 节的 `request.financial()` 调用，逐项替换关系：
 *
 * | Pine | 这里 |
 * | --- | --- |
 * | `EARNINGS_PER_SHARE_DILUTED` TTM | 最近 4 个季度 `epsDiluted` 求和 |
 * | `TOTAL_REVENUE` TTM | 最近 4 个季度 `revenue` 求和 |
 * | `TOTAL_SHARES_OUTSTANDING` FQ | 最近一季 `weightedAverageShsOutDil` |
 * | `MARKET_CAP` D | `profile.marketCap` |
 * | `EARNINGS_PER_SHARE_DILUTED` FQ_YOY | 最近一季与去年同季 `epsDiluted` 的同比 |
 * | `syminfo.target_price_average` | `price-target-consensus.targetConsensus` |
 * | `syminfo.target_price_estimates` | `price-target-summary.lastQuarterCount` |
 *
 * 两处口径差异：股本用的是**摊薄加权平均**而非期末总股本（FMP 的季报口径），
 * 分析师家数用的是**近一季**给出目标价的家数（Pine 那个是当期在覆盖的家数）。
 * 前者只影响 PS 模型的每股营收，后者只用于 `>= 3` 这个开关，都不敏感。
 */
export type ValuationInputs = {
  symbol: string;
  epsTtm: number | null;
  revTtm: number | null;
  sharesOutstanding: number | null;
  marketCap: number | null;
  /** 单季 EPS 同比增速，去年同季为负时无意义、记 null */
  epsQYoY: number | null;
  analystTarget: number | null;
  analystCount: number;
};

type FmpValuationIncomeRow = {
  date?: string;
  revenue?: number;
  epsDiluted?: number;
  weightedAverageShsOutDil?: number;
};

type FmpProfileMarketCapRow = { marketCap?: number };
type FmpTargetSummaryRow = { lastQuarterCount?: number };

const sumOrNull = (values: (number | undefined)[]): number | null =>
  values.length === 0 || values.some((v) => v == null)
    ? null
    : values.reduce<number>((a, v) => a + v!, 0);

export async function fetchFmpValuationInputs(symbol: string): Promise<ValuationInputs | null> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return null;

  const q = encodeURIComponent(symbol);
  const [income, profile, consensus, summary] = await Promise.all([
    safeJson<FmpValuationIncomeRow[]>(
      `${FMP_BASE}/income-statement?symbol=${q}&period=quarter&limit=5&apikey=${apiKey}`,
    ),
    safeJson<FmpProfileMarketCapRow[]>(`${FMP_BASE}/profile?symbol=${q}&apikey=${apiKey}`),
    safeJson<FmpPriceTargetRow[]>(
      `${FMP_BASE}/price-target-consensus?symbol=${q}&apikey=${apiKey}`,
    ),
    safeJson<FmpTargetSummaryRow[]>(
      `${FMP_BASE}/price-target-summary?symbol=${q}&apikey=${apiKey}`,
    ),
  ]);

  if (!income || income.length === 0) return null;

  const last4 = income.slice(0, 4);
  const epsTtm = last4.length === 4 ? sumOrNull(last4.map((r) => r.epsDiluted)) : null;
  const revTtm = last4.length === 4 ? sumOrNull(last4.map((r) => r.revenue)) : null;

  const epsLatest = income[0]?.epsDiluted;
  const epsYearAgo = income[4]?.epsDiluted;
  const epsQYoY =
    epsLatest != null && epsYearAgo != null && epsYearAgo > 0
      ? (epsLatest - epsYearAgo) / epsYearAgo
      : null;

  return {
    symbol,
    epsTtm,
    revTtm,
    sharesOutstanding: income[0]?.weightedAverageShsOutDil ?? null,
    marketCap: profile?.[0]?.marketCap ?? null,
    epsQYoY,
    analystTarget: consensus?.[0]?.targetConsensus ?? null,
    analystCount: summary?.[0]?.lastQuarterCount ?? 0,
  };
}

export type CompanyProfile = {
  symbol: string;
  sector: string | null;
  industry: string | null;
  /** 公司简介（已截断） */
  description: string | null;
};

type FmpProfileRow = {
  symbol?: string;
  sector?: string;
  industry?: string;
  description?: string;
};

const truncateDesc = (text: string, max = 160) => {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
};

/** FMP company profile：行业 + 简介（非 LLM） */
export async function fetchFmpProfile(symbol: string): Promise<CompanyProfile | null> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) return null;

  const rows = await safeJson<FmpProfileRow[]>(
    `${FMP_BASE}/profile?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`,
  );
  const row = rows?.[0];
  if (!row) return null;

  return {
    symbol,
    sector: row.sector?.trim() || null,
    industry: row.industry?.trim() || null,
    description: row.description ? truncateDesc(row.description) : null,
  };
}
