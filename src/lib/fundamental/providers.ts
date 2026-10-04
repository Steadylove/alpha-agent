import {
  FUNDAMENTAL_VERSION,
  inputSchema,
  sourceSchema,
  symbolSchema,
  type AnnualEstimate,
  type FundamentalFinancials,
  type FundamentalInput,
  type FundamentalPeer,
  type FundamentalSource,
} from "./types";
import { forwardEps } from "./engine";
import { createFundamentalRequestGate } from "./requestGate";

const FMP_BASE = "https://financialmodelingprep.com/stable";
const MAX_PEERS = 8;
const MAX_FALLBACK_CANDIDATES = 12;
const MAX_CANDIDATE_CHECKS = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type Row = Record<string, unknown>;
type Result = { rows: Row[]; url: string; error: string | null };
export type FundamentalRequestObservation = {
  endpoint: string; symbol: string | null; period: string | null; limit: number | null;
  status: "ok" | "empty" | "http-error" | "invalid-response" | "request-failed";
  httpStatus: number | null; rows: number | null; observedAt: string;
};
export type FundamentalProviderOptions = {
  now?: Date;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Minimum gap between uncached request starts within this job. Defaults to 1000 ms. */
  requestIntervalMs?: number;
  /** Candidate discovery only; final industry, issuer and currency checks always use FMP profiles. */
  peerDirectory?: readonly { symbol: string; industry: string }[];
  /** Sanitized diagnostics: no URL, authorization header, response body or exception text. */
  onRequest?: (observation: FundamentalRequestObservation) => void;
};
export class FundamentalRateLimitError extends Error {
  constructor() {
    super("FMP HTTP 429 限流；本轮采集未完成，已停止新增请求");
    this.name = "FundamentalRateLimitError";
  }
}

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const positive = (value: unknown): number | null => {
  const result = number(value);
  return result !== null && result > 0 ? result : null;
};
const day = (value: unknown): string | null => {
  const date = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
};
const filedAt = (row: Row): string | null => day(row.filingDate) ?? day(row.acceptedDate);
const financialSector = (sector: string): boolean => /^(financial services|financials|real estate)$/i.test(sector);
const issuerCik = (row: Row): string | null => {
  const cik = text(row.cik).replace(/^0+/, "");
  return /^\d+$/.test(cik) ? cik : null;
};
const issuerName = (row: Row): string | null => {
  const name = text(row.companyName).toLowerCase().replace(/\bclass\s+[a-z]\b/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
  return name.length >= 3 ? name : null;
};

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty response");
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    await response.body.cancel();
    throw new Error("Response too large");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let size = 0, value = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Response too large");
      value += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(value + decoder.decode()) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** FMP dates identify fiscal ends, not consensus publication dates. Never backdate observations. */
function estimates(rows: Row[], symbol: string, sourceId: string, warnings: string[]): AnnualEstimate[] {
  const seen = new Set<string>();
  const values: AnnualEstimate[] = [];
  for (const row of rows) {
    if (text(row.symbol) !== symbol) continue;
    const fiscalEnd = day(row.date);
    if (!fiscalEnd) continue;
    if (seen.has(fiscalEnd)) {
      warnings.push(`${symbol}: 重复预测财年 ${fiscalEnd}，仅保留第一条供应商记录。`);
      continue;
    }
    seen.add(fiscalEnd);
    const count = number(row.numAnalystsEps);
    values.push({
      fiscalEnd,
      epsLow: number(row.epsLow),
      epsAvg: number(row.epsAvg),
      epsHigh: number(row.epsHigh),
      revenueAvg: number(row.revenueAvg),
      analystCount: count !== null && Number.isInteger(count) && count >= 0 ? count : 0,
      sourceId,
    });
  }
  return values.sort((a, b) => a.fiscalEnd.localeCompare(b.fiscalEnd)).slice(-12);
}

function reportedRows(rows: Row[], symbol: string, today: string, annual: boolean): Row[] {
  return rows.filter(row => {
    const fiscalEnd = day(row.date);
    const published = filedAt(row);
    const period = text(row.period);
    return text(row.symbol) === symbol && fiscalEnd !== null && fiscalEnd <= today &&
      published !== null && published >= fiscalEnd && published <= today &&
      (annual ? period === "FY" : /^Q[1-4]$/.test(period));
  }).sort((a, b) => day(b.date)!.localeCompare(day(a.date)!) || filedAt(b)!.localeCompare(filedAt(a)!));
}

function source(id: string, label: string, result: Result, observedAt: string, publishedAt: string | null = null, row?: Row): FundamentalSource {
  const filingUrl = [row?.finalLink, row?.finalLinkUrl, row?.link]
    .map(value => sourceSchema.shape.url.safeParse(value)).find(value => value.success);
  return { id, label, url: filingUrl?.success ? filingUrl.data : result.url, observedAt, publishedAt };
}

/** One instance per job: overlapping tickers/peers share requests, with no cross-job stale cache. */
export function createFundamentalProvider(options: FundamentalProviderOptions = {}) {
  const apiKey = options.apiKey ?? process.env.FMP_API_KEY;
  const observedAt = (options.now ?? new Date()).toISOString();
  const today = observedAt.slice(0, 10);
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestGate = createFundamentalRequestGate(options.requestIntervalMs);
  const cache = new Map<string, Promise<Result>>();
  let rateLimited = false;
  const assertNotRateLimited = () => {
    if (rateLimited) throw new FundamentalRateLimitError();
  };

  const request = (endpoint: string, symbol: string | null, params: Record<string, string> = {}): Promise<Result> => {
    const query = new URLSearchParams({ ...(symbol ? { symbol } : {}), ...params });
    const url = `${FMP_BASE}/${endpoint}?${query}`;
    const existing = cache.get(url);
    if (existing) return existing;
    // Other requests already in flight may complete, but a 429 closes this job to all new requests.
    // A skipped request is not emitted as a vendor observation and is never retried here.
    if (rateLimited) return Promise.resolve({ rows: [], url, error: "HTTP 429 限流；本轮已停止新增请求" });
    const pending = (async (): Promise<Result> => {
      let httpStatus: number | null = null;
      const observe = (status: FundamentalRequestObservation["status"], rows: number | null) => {
        try { options.onRequest?.({ endpoint, symbol, period: params.period ?? null,
          limit: params.limit ? Number(params.limit) : null, status, httpStatus, rows,
          observedAt: new Date().toISOString() }); } catch { /* Diagnostics must not affect data collection. */ }
      };
      try {
        await requestGate(assertNotRateLimited);
        const response = await fetchImpl(url, {
          headers: { apikey: apiKey! }, cache: "no-store", signal: AbortSignal.timeout(15_000),
        });
        httpStatus = response.status;
        if (httpStatus === 429) rateLimited = true;
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          observe("http-error", null);
          return { rows: [], url, error: `HTTP ${response.status}` };
        }
        const body = await boundedJson(response);
        if (!Array.isArray(body)) {
          observe("invalid-response", null);
          return { rows: [], url, error: "供应商返回非数组数据或权限错误" };
        }
        const rows = body.filter((row): row is Row => typeof row === "object" && row !== null && !Array.isArray(row));
        observe(rows.length ? "ok" : "empty", rows.length);
        return {
          rows, url, error: null,
        };
      } catch (error) {
        // A queued request cancelled by the circuit never reached the vendor.
        if (error instanceof FundamentalRateLimitError) return { rows: [], url, error: "HTTP 429 限流；本轮已停止新增请求" };
        observe("request-failed", null);
        // Never propagate request URLs, provider payloads or exception messages containing credentials.
        return { rows: [], url, error: "请求失败或超时" };
      }
    })();
    cache.set(url, pending);
    return pending;
  };

  const requestEstimates = async (symbol: string): Promise<Result> => {
    const result = await request("analyst-estimates", symbol, { period: "annual", page: "0", limit: "10" });
    // Some subscriptions restrict historical depth. The engine still verifies complete future coverage.
    return result.error === "HTTP 402"
      ? request("analyst-estimates", symbol, { period: "annual", page: "0", limit: "5" })
      : result;
  };

  return async (rawSymbol: string): Promise<FundamentalInput> => {
    if (!apiKey?.trim()) throw new Error("基本面数据源未配置 FMP_API_KEY");
    const symbol = symbolSchema.parse(rawSymbol.trim().toUpperCase());
    assertNotRateLimited();
    const warnings: string[] = [];
    const sources: FundamentalSource[] = [];
    const annual = { period: "annual", limit: "5" };
    const profileResult = await request("profile", symbol);
    assertNotRateLimited();
    const profile = profileResult.rows.find(row => text(row.symbol) === symbol);
    if (!profile) throw new Error(`${symbol}: 公司资料不可用（${profileResult.error ?? "无匹配记录"}）`);
    const companyName = text(profile.companyName) || symbol;
    const industry = text(profile.industry);
    const sector = text(profile.sector);
    const currency = text(profile.currency);
    const price = positive(profile.price);
    sources.push(source(`${symbol}:profile`, `${symbol} 公司资料及观测价格`, profileResult, observedAt));
    if (!industry || !sector) warnings.push(`${symbol}: 缺少行业或板块分类。`);
    if (!price) warnings.push(`${symbol}: 缺少有效观测价格。`);
    if (profile.isAdr === true) warnings.push(`${symbol}: ADR 每股口径需单独核实，V1 不覆盖。`);
    if (profile.isFund === true) warnings.push(`${symbol}: 基金不适用公司盈利估值，V1 不覆盖。`);

    const [income, quarter, balance, cashFlow, estimateResult, peersResult] = await Promise.all([
      request("income-statement", symbol, annual),
      request("income-statement", symbol, { period: "quarter", limit: "2" }),
      request("balance-sheet-statement", symbol, annual),
      request("cash-flow-statement", symbol, annual),
      requestEstimates(symbol),
      request("stock-peers", symbol),
    ]);
    assertNotRateLimited();
    const endpointResults = [
      ["年度利润表", income], ["季度利润表", quarter], ["年度资产负债表", balance],
      ["年度现金流表", cashFlow], ["年度盈利预测", estimateResult], ["同行候选", peersResult],
    ] as const;
    for (const [label, result] of endpointResults) {
      if (result.error || result.rows.length === 0) warnings.push(`${symbol}: ${label}不可用（${result.error ?? "空数据"}）。`);
    }
    const estimateId = `${symbol}:estimates`;
    sources.push(source(estimateId, `${symbol} 年度 Non-GAAP 分析师预测（发布日期未提供）`, estimateResult, observedAt));
    const ownEstimates = estimates(estimateResult.rows, symbol, estimateId, warnings);
    const latestIncome = reportedRows(income.rows, symbol, today, true)[0];
    let financials: FundamentalFinancials | null = null;
    if (latestIncome) {
      const fiscalEnd = day(latestIncome.date)!;
      const reportedCurrency = text(latestIncome.reportedCurrency);
      const matching = (result: Result): Row | undefined => reportedRows(result.rows, symbol, today, true)
        .find(row => day(row.date) === fiscalEnd && text(row.reportedCurrency) === reportedCurrency);
      const balanceRow = matching(balance);
      const cashRow = matching(cashFlow);
      const quarterRow = reportedRows(quarter.rows, symbol, today, false)
        .find(row => text(row.reportedCurrency) === reportedCurrency);
      const incomeId = `${symbol}:income:${fiscalEnd}`;
      const ids = [incomeId];
      sources.push(source(incomeId, `${symbol} FY ${fiscalEnd} 利润表 · ${reportedCurrency} / 每股 / 股`, income, observedAt, filedAt(latestIncome), latestIncome));
      for (const [kind, label, result, row] of [
        ["balance", "资产负债表", balance, balanceRow],
        ["cash-flow", "现金流表", cashFlow, cashRow],
      ] as const) {
        if (!row) {
          warnings.push(`${symbol}: ${label}未匹配 ${fiscalEnd} 同一报告币种，不混用其他财年。`);
          continue;
        }
        const id = `${symbol}:${kind}:${fiscalEnd}`;
        ids.push(id);
        sources.push(source(id, `${symbol} FY ${fiscalEnd} ${label} · ${reportedCurrency}`, result, observedAt, filedAt(row), row));
      }
      if (quarterRow) {
        const id = `${symbol}:quarter:${day(quarterRow.date)}`;
        ids.push(id);
        sources.push(source(id, `${symbol} ${day(quarterRow.date)} 单季 GAAP EPS · ${reportedCurrency}/股`, quarter, observedAt, filedAt(quarterRow), quarterRow));
      } else warnings.push(`${symbol}: 缺少已披露的同币种最新季度盈利。`);
      financials = {
        fiscalEnd, filedAt: filedAt(latestIncome)!, currency: reportedCurrency,
        revenue: number(latestIncome.revenue), netIncome: number(latestIncome.netIncome),
        operatingIncome: number(latestIncome.operatingIncome), reportedEps: number(latestIncome.epsDiluted),
        dilutedWeightedShares: positive(latestIncome.weightedAverageShsOutDil),
        freeCashFlow: number(cashRow?.freeCashFlow), cash: number(balanceRow?.cashAndCashEquivalents),
        debt: number(balanceRow?.totalDebt),
        latestQuarter: quarterRow ? {
          fiscalEnd: day(quarterRow.date)!, filedAt: filedAt(quarterRow)!, eps: number(quarterRow.epsDiluted),
        } : null,
        sourceIds: ids,
      };
    } else warnings.push(`${symbol}: 缺少带有效披露日期的年度财报，不能当作已知事实。`);

    sources.push(source(`${symbol}:peer-candidates`, `${symbol} 供应商同行候选（仍须行业复核）`, peersResult, observedAt));
    const candidates = [...new Set(peersResult.rows.map(row => text(row.symbol)).filter(value =>
      value !== symbol && symbolSchema.safeParse(value).success,
    ))].slice(0, MAX_CANDIDATE_CHECKS);
    const peers: FundamentalPeer[] = [];
    const checked = new Set<string>();
    const ownIssuer = { cik: issuerCik(profile), name: issuerName(profile) };
    const issuers = [ownIssuer];
    if (!ownIssuer.cik && !ownIssuer.name) warnings.push(`${symbol}: 发行人标识与公司名称均缺失，无法核验独立同业。`);
    const addPeer = async (peerSymbol: string): Promise<void> => {
      if (checked.has(peerSymbol) || checked.size >= MAX_CANDIDATE_CHECKS || peers.length >= MAX_PEERS ||
        (!ownIssuer.cik && !ownIssuer.name)) return;
      checked.add(peerSymbol);
      const peerProfileResult = await request("profile", peerSymbol);
      assertNotRateLimited();
      const peerProfile = peerProfileResult.rows.find(row => text(row.symbol) === peerSymbol);
      if (!peerProfile) {
        warnings.push(`${peerSymbol}: 同业公司资料不可用（${peerProfileResult.error ?? "空数据"}）。`);
        return;
      }
      if (!industry || text(peerProfile.industry).toLowerCase() !== industry.toLowerCase() ||
        text(peerProfile.currency) !== "USD" || peerProfile.isEtf === true ||
        peerProfile.isFund === true || peerProfile.isAdr === true ||
        financialSector(text(peerProfile.sector))) return;
      const issuer = { cik: issuerCik(peerProfile), name: issuerName(peerProfile) };
      if (!issuer.cik && !issuer.name) {
        warnings.push(`${peerSymbol}: 无 CIK 或可识别公司名称，未计作独立同业。`);
        return;
      }
      if (issuers.some(other => issuer.cik && other.cik
        ? issuer.cik === other.cik
        : issuer.name !== null && issuer.name === other.name)) return;
      // With a missing CIK, names must be available on both sides to rule out share-class duplicates.
      if (issuers.some(other => (!issuer.cik || !other.cik) && (!issuer.name || !other.name))) return;
      const peerPrice = positive(peerProfile.price);
      if (!peerPrice) return;
      const [peerEstimates, peerIncome] = await Promise.all([
        requestEstimates(peerSymbol), request("income-statement", peerSymbol, annual),
      ]);
      assertNotRateLimited();
      if (peerEstimates.error) warnings.push(`${peerSymbol}: 同行业盈利预测不可用（${peerEstimates.error}）。`);
      const latestPeerIncome = reportedRows(peerIncome.rows, peerSymbol, today, true)[0];
      // Trading USD alone does not establish that the consensus EPS is reported in USD.
      if (!latestPeerIncome) {
        warnings.push(`${peerSymbol}: 同业已披露年度财报不可用（${peerIncome.error ?? "无有效记录"}）。`);
        return;
      }
      if (text(latestPeerIncome.reportedCurrency) !== "USD") return;
      const profileId = `${peerSymbol}:profile`;
      const estimatesId = `${peerSymbol}:estimates`;
      const incomeId = `${peerSymbol}:income:${day(latestPeerIncome.date)}`;
      const values = estimates(peerEstimates.rows, peerSymbol, estimatesId, warnings);
      if (!values.length) {
        warnings.push(`${peerSymbol}: 同行业盈利预测不可用（${peerEstimates.error ?? "空数据"}）。`);
        return;
      }
      const ntmEps = forwardEps(values, today), pe = ntmEps === null ? null : peerPrice / ntmEps;
      if (pe === null || pe < 2 || pe > 100) {
        warnings.push(`${peerSymbol}: 当前 NTM 预测覆盖不足或 Forward P/E 不在模型适用范围，未计作有效同业。`);
        return;
      }
      if (!issuer.cik || !ownIssuer.cik) warnings.push(`${peerSymbol}: CIK 不完整，以规范化公司名称核验发行人去重。`);
      sources.push(
        source(profileId, `${peerSymbol} 同行业资料及观测价格`, peerProfileResult, observedAt),
        source(estimatesId, `${peerSymbol} 年度 Non-GAAP 分析师预测（发布日期未提供）`, peerEstimates, observedAt),
        source(incomeId, `${peerSymbol} 财报报告币种及披露日期`, peerIncome, observedAt, filedAt(latestPeerIncome), latestPeerIncome),
      );
      peers.push({ symbol: peerSymbol, industry, currency: "USD", price: peerPrice, observedAt,
        estimates: values, sourceIds: [profileId, estimatesId, incomeId] });
      issuers.push(issuer);
    };
    // Sequential candidates bound provider concurrency and keep warnings/source ordering deterministic.
    for (const peerSymbol of candidates) await addPeer(peerSymbol);
    const directoryIndustry = options.peerDirectory?.find(row => row.symbol.trim().toUpperCase() === symbol)?.industry.trim();
    if (peers.length < 3 && directoryIndustry && checked.size < MAX_CANDIDATE_CHECKS) {
      const directoryCandidates = [...new Set(options.peerDirectory!.filter(row =>
        row.industry.trim().toLowerCase() === directoryIndustry.toLowerCase(),
      ).map(row => row.symbol.trim().toUpperCase()).filter(candidate => candidate !== symbol &&
        !checked.has(candidate) && symbolSchema.safeParse(candidate).success))]
        .sort().slice(0, MAX_CANDIDATE_CHECKS - checked.size);
      if (directoryCandidates.length) warnings.push(`${symbol}: 补充候选来自本地行业目录；最终仍以 FMP 公司行业、币种与发行人核验。`);
      for (const peerSymbol of directoryCandidates) await addPeer(peerSymbol);
    }
    if (peers.length < 3 && checked.size < MAX_CANDIDATE_CHECKS && industry && !financialSector(sector) && currency === "USD" &&
      !profile.isEtf && !profile.isFund && !profile.isAdr) {
      const marketCap = positive(profile.marketCap);
      if (!marketCap) warnings.push(`${symbol}: 缺少有效市值，无法按规模筛选同业回退候选。`);
      else {
        const screener = await request("company-screener", null, {
          industry, country: "US", isEtf: "false", isFund: "false", isActivelyTrading: "true",
          includeAllShareClasses: "false", page: "0", limit: "1000",
        });
        assertNotRateLimited();
        sources.push(source(`${symbol}:industry-candidates`, `${symbol} 同行业回退候选 · 按市值接近程度筛选`, screener, observedAt));
        if (screener.error) warnings.push(`${symbol}: 同行业候选回退不可用（${screener.error}）。`);
        const ranked = screener.rows.filter(row => text(row.industry).toLowerCase() === industry.toLowerCase() &&
          positive(row.marketCap) !== null && row.isEtf !== true && row.isFund !== true &&
          text(row.symbol) !== symbol && !checked.has(text(row.symbol)) && symbolSchema.safeParse(text(row.symbol)).success)
          .sort((a, b) => Math.abs(Math.log(positive(a.marketCap)! / marketCap)) -
            Math.abs(Math.log(positive(b.marketCap)! / marketCap)) || text(a.symbol).localeCompare(text(b.symbol)));
        const fallback = [...new Set(ranked.map(row => text(row.symbol)))].slice(0, MAX_FALLBACK_CANDIDATES);
        for (const peerSymbol of fallback) await addPeer(peerSymbol);
      }
    }
    if (peers.length < 3) warnings.push(`${symbol}: 通过同业与币种核验的候选仅 ${peers.length} 家，至少需要 3 家有效 Forward P/E 同行。`);
    return inputSchema.parse({
      version: FUNDAMENTAL_VERSION, symbol, companyName, sector, industry, currency,
      isEtf: profile.isEtf === true || profile.isFund === true, isAdr: profile.isAdr === true,
      observedAt, quote: price ? { price, observedAt } : null,
      earningsBasis: "non-gaap-consensus", financials, estimates: ownEstimates, peers,
      sources: [...new Map(sources.map(value => [value.id, value])).values()],
      warnings: [...new Set(warnings)].slice(0, 40),
    });
  };
}

export async function fetchFundamentalInput(symbol: string, options: FundamentalProviderOptions = {}): Promise<FundamentalInput> {
  return createFundamentalProvider(options)(symbol);
}
