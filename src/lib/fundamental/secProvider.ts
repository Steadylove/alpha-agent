import { normalizeSecPeriods as normalizePeriods, SecFinancialDataUnavailable as DataUnavailable } from "./secFinancials";
import { readCsvPanel } from "@/lib/backtest/csvPanel";
import { csvDir } from "@/lib/backtest/marketStore";
import { inputSchema, symbolSchema, type FundamentalInput, type FundamentalSource, type ReportedPeer } from "./types";
import type { FundamentalRequestObservation } from "./providers";
import { reportedPeerMultiple } from "./scenarioEngine";
import { parseSecIncorporationState, selectSecIncorporationFiling, SEC_INCORPORATION_DOCUMENT_MAX_BYTES } from "./secIssuerEvidence";
import type { SecIssuerDirectoryEntry } from "./secIssuerDirectory";

type Json = Record<string, unknown>;
type Quote = { price: number; observedAt: string };
type DirectoryEntry = { symbol: string; industry: string; sector?: string };
export type SecFundamentalProviderOptions = {
  userAgent?: string;
  now?: Date | (() => Date);
  fetchFn?: typeof fetch;
  fetchImpl?: typeof fetch;
  onRequest?: (observation: FundamentalRequestObservation) => void;
  peerDirectory?: readonly DirectoryEntry[];
  /** Frozen at construction; discoveries are only eligible as seeds in later runs. */
  issuerDirectory?: readonly SecIssuerDirectoryEntry[];
  onIssuer?: (entry: SecIssuerDirectoryEntry) => void;
  quoteReader?: (symbol: string) => Quote | null | Promise<Quote | null>;
  /** Test-only pacing override; production defaults to one request per second. */
  requestIntervalMs?: number;
};
export class SecFundamentalError extends Error {}
export class SecFundamentalConfigurationError extends SecFundamentalError {
  constructor() { super("免费 SEC 基本面源需显式配置含真实联系邮箱的 SEC_USER_AGENT"); this.name = "SecFundamentalConfigurationError"; }
}
export class SecFundamentalAccessError extends SecFundamentalError {
  constructor(readonly status: number) { super(`SEC HTTP ${status}；本轮已停止新增 SEC 请求`); this.name = "SecFundamentalAccessError"; }
}
const DAY = 86_400_000;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown) => typeof value === "string" ? value.trim() : "";
const day = (value: unknown): string | null => {
  const text = string(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(text)) && new Date(text).toISOString().slice(0, 10) === text ? text : null;
};
const normalizedSymbol = (value: string) => value.trim().toUpperCase().replace(/-/g, ".");

/** This is a saved daily close. No HTTP quote endpoint or realtime claim is made. */
export function readSecFundamentalQuote(symbol: string): Quote | null {
  const panel = readCsvPanel(csvDir("1d"), symbol);
  if (!panel) return null;
  const rows = panel.dates.map((date, index) => ({ date: day(date), price: panel.close[index] }))
    .filter((row): row is { date: string; price: number } => row.date !== null && Number.isFinite(row.price) && row.price > 0)
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = rows[0];
  // UTC day end conservatively avoids treating an unfinished day's bar as a known close.
  return latest ? { price: latest.price, observedAt: `${latest.date}T23:59:59.000Z` } : null;
}

/** One instance per job shares its request gate, caches and access circuit. */
export function createSecFundamentalProvider(options: SecFundamentalProviderOptions = {}) {
  const ua = (options.userAgent ?? process.env.SEC_USER_AGENT ?? "").trim();
  const fetcher = options.fetchFn ?? options.fetchImpl ?? fetch;
  const now = typeof options.now === "function" ? options.now : () => options.now instanceof Date ? options.now : new Date();
  const quoteReader = options.quoteReader ?? readSecFundamentalQuote;
  const issuerDirectory = (options.issuerDirectory ?? []).map(entry => ({ ...entry }));
  const interval = Math.max(0, options.requestIntervalMs ?? 1000);
  const cache = new Map<string, Promise<Json | string>>();
  let queue = Promise.resolve(), nextRequest = 0, blocked: SecFundamentalAccessError | null = null;
  const configured = () => {
    if (!ua || ua.length > 300 || /[\r\n]/.test(ua) || !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(ua) || /example\.(com|org|net)|\.local(?:\s|$)|\.invalid(?:\s|$)/i.test(ua)) throw new SecFundamentalConfigurationError();
    if (blocked) throw blocked;
  };
  function request(url: string, symbol?: string | null): Promise<Json>;
  function request(url: string, symbol: string | null, format: "text"): Promise<string>;
  async function request(url: string, symbol: string | null = null, format: "json" | "text" = "json"): Promise<Json | string> {
    configured();
    const key = `${format}:${url}`, saved = cache.get(key);
    if (saved) return saved;
    const result = queue.then(async () => {
      configured();
      const delay = Math.max(0, nextRequest - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      configured();
      nextRequest = Date.now() + interval;
      const endpoint = format === "text" ? "filing-cover" : url.includes("companyfacts") ? "companyfacts" : url.includes("submissions") ? "submissions" : "company-tickers";
      const report = (status: FundamentalRequestObservation["status"], httpStatus: number | null, rows: number | null = null) => {
        try { options.onRequest?.({ endpoint, symbol, period: null, limit: null, status, httpStatus, rows, observedAt: now().toISOString() }); } catch { /* Diagnostics must not change collection. */ }
      };
      let response: Response;
      try { response = await fetcher(url, { headers: { "User-Agent": ua, Accept: format === "text" ? "text/html" : "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "error", cache: "no-store" }); }
      catch { report("request-failed", null); throw new DataUnavailable("SEC 请求失败或超时"); }
      if (response.status === 403 || response.status === 429) { report("http-error", response.status); blocked = new SecFundamentalAccessError(response.status); throw blocked; }
      if (!response.ok) { report("http-error", response.status); throw new DataUnavailable(`SEC HTTP ${response.status}`); }
      try {
        const maximum = format === "text" ? SEC_INCORPORATION_DOCUMENT_MAX_BYTES : 30 * 1024 * 1024;
        if (!response.body || Number(response.headers.get("content-length")) > maximum) { await response.body?.cancel(); throw new Error(); }
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let size = 0, body = "";
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maximum) throw new Error();
            body += decoder.decode(chunk.value, { stream: true });
          }
          body += decoder.decode();
        } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
        finally { reader.releaseLock(); }
        if (format === "text") {
          if (!body.trim()) throw new Error();
          report("ok", response.status);
          return body;
        }
        const json = object(JSON.parse(body));
        if (!Object.keys(json).length) throw new Error();
        report("ok", response.status, Object.keys(json).length);
        return json;
      } catch { report("invalid-response", response.status); throw new DataUnavailable("SEC 响应格式无效或过大"); }
    });
    cache.set(key, result);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }
  return async (rawSymbol: string): Promise<FundamentalInput> => {
    configured();
    const symbol = symbolSchema.parse(rawSymbol.trim().toUpperCase()), observed = now(), observedAt = observed.toISOString(), today = observedAt.slice(0, 10);
    const warnings: string[] = [], sources: FundamentalSource[] = [];
    const directory = options.peerDirectory ?? [];
    const directoryEntry = directory.find(row => normalizedSymbol(row.symbol) === normalizedSymbol(symbol));
    const directoryIndustry = directoryEntry?.industry.trim().toLowerCase() ?? "";
    const directorySector = directoryEntry?.sector?.trim().toLowerCase() ?? "";
    let companyName = symbol, industry = "", sector = "", isAdr = false;
    let quote: Quote | null = null, scenario: FundamentalInput["scenario"];
    async function getQuote(ticker: string): Promise<Quote | null> {
      try {
        const value = await quoteReader(ticker), stamp = Date.parse(value?.observedAt ?? "");
        if (!value || !Number.isFinite(value.price) || value.price <= 0 || !Number.isFinite(stamp) || stamp > observed.getTime() || observed.getTime() - stamp > 7 * DAY) return null;
        warnings.push(`${ticker}: 行情来自本地已保存日线 CSV，原始供应商未随 CSV 留档，非实时。`);
        return { price: value.price, observedAt: new Date(stamp).toISOString() };
      } catch { return null; }
    }
    try {
      quote = await getQuote(symbol);
      if (!quote) warnings.push(`${symbol}: 缺少 7 日内且不晚于当前时间的已保存日线收盘价。`);
      const map = await request("https://www.sec.gov/files/company_tickers.json");
      const tickerMap = new Map<string, string>();
      for (const value of Object.values(map)) {
        const row = object(value), valueCik = String(row.cik_str ?? "");
        if (/^\d{1,10}$/.test(valueCik) && string(row.ticker)) tickerMap.set(normalizedSymbol(string(row.ticker)), valueCik.padStart(10, "0"));
      }
      const seen = new Set<string>();
      async function company(ticker: string, requiredSic?: number) {
        const cik = tickerMap.get(normalizedSymbol(ticker));
        if (!cik) throw new DataUnavailable("SEC 无唯一发行人 CIK 映射");
        if (seen.has(cik)) return null;
        seen.add(cik);
        const meta = await request(`https://data.sec.gov/submissions/CIK${cik}.json`, ticker), recent = object(object(meta.filings).recent);
        const forms = Array.isArray(recent.form) ? recent.form : [], filingDates = Array.isArray(recent.filingDate) ? recent.filingDate : [];
        const permittedForms = forms.filter((_, i) => day(filingDates[i]) && String(filingDates[i]) < today);
        const tickers = Array.isArray(meta.tickers) ? meta.tickers : [], sic = Number(meta.sic);
        if (String(meta.cik).padStart(10, "0") !== cik || !tickers.some(value => normalizedSymbol(string(value)) === normalizedSymbol(ticker)) || !string(meta.name) || !Number.isInteger(sic) || sic <= 0) throw new DataUnavailable("发行人身份、运营实体类型或 SIC 无法确认");
        try { options.onIssuer?.({ symbol: ticker, cik, sic, observedAt, sourceUrl: `https://data.sec.gov/submissions/CIK${cik}.json` }); }
        catch { /* Directory persistence must not alter current financial evidence. */ }
        if (permittedForms.some(form => /^(20-F|40-F|6-K)(\/A)?$/.test(String(form))) || !permittedForms.some(form => /^10-[KQ](\/A)?$/.test(String(form))))
          throw new DataUnavailable("外国或未知申报制度，当前仅支持已核实的 10-K/10-Q 财报");
        if (string(meta.entityType) !== "operating") throw new DataUnavailable("运营实体类型无法确认");
        if (sic >= 6000 && sic <= 6999) throw new DataUnavailable("金融及房地产 SIC 6000–6999 不适用此盈利模型");
        if (requiredSic !== undefined && sic !== requiredSic) throw new DataUnavailable("实际 SEC SIC 与目标公司不一致");
        if (/\bADR\b|Depositary/i.test(string(meta.name))) throw new DataUnavailable("ADR 每股换算口径未核实");
        const usStates = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
        let incorporation = string(meta.stateOfIncorporation);
        const cover = !incorporation ? selectSecIncorporationFiling(meta, cik, today) : null;
        if (!incorporation && cover) {
          incorporation = parseSecIncorporationState(await request(cover.url, ticker, "text")) ?? "";
        }
        if (!usStates.includes(incorporation)) throw new DataUnavailable("美国国内注册身份无法确认");
        const raw = await request(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, ticker);
        if (String(raw.cik).padStart(10, "0") !== cik) throw new DataUnavailable("财报与发行人 CIK 不一致");
        const periods = normalizePeriods(raw, cik, today);
        warnings.push(...periods.warnings.map(warning => `${ticker}: ${warning}`));
        if (cover) {
          sources.push({ id: `sec:${cik}:${cover.accn}:incorporation`, label: `${ticker} ${cover.filedAt} 年报封面注册州 ${incorporation}`,
            url: cover.url, observedAt, publishedAt: `${cover.filedAt}T23:59:59.000Z` });
          warnings.push(`${ticker}: submissions 注册州为空，已依据官方年报封面的 DEI 注册地字段核实为 ${incorporation}。`);
        }
        sources.push({ id: `sec:${cik}:identity`, label: `${ticker} SEC 发行人及 SIC ${sic}`, url: `https://data.sec.gov/submissions/CIK${cik}.json`, observedAt, publishedAt: null });
        const needed = new Set([...periods.current.sourceIds, ...(requiredSic === undefined ? periods.prior.sourceIds : [])]);
        for (const row of periods.evidence) if (needed.has(`sec:${cik}:${row.accn}`)) sources.push({ id: `sec:${cik}:${row.accn}`, label: `${ticker} ${row.form} 报告数据（TTM/单季可由累计值推导）`, url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${row.accn.replace(/-/g, "")}/${row.accn}-index.html`, observedAt, publishedAt: `${row.filed}T23:59:59.000Z` });
        return { meta, periods, cik };
      }
      const own = await company(symbol);
      if (!own) throw new DataUnavailable("重复发行人");
      companyName = string(own.meta.name); sector = string(own.meta.sicDescription);
      industry = `SEC SIC ${Number(own.meta.sic)} · ${sector}`;
      if (!directoryIndustry) warnings.push(`${symbol}: 本地目录缺少行业分类，仅可从已保存的同 SIC 目录发现同行。`);
      const peers: ReportedPeer[] = [];
      const candidateIssuers = new Set([own.cik]);
      // Directory labels only seed discovery. Include other industries in the
      // same broad sector, but verify the exact SEC SIC before accepting a peer.
      const knownSics = new Map(issuerDirectory.filter(row => tickerMap.get(normalizedSymbol(row.symbol)) === row.cik)
        .map(row => [normalizedSymbol(row.symbol), row.sic]));
      const sameSic = (row: DirectoryEntry) => knownSics.get(normalizedSymbol(row.symbol)) === Number(own.meta.sic);
      const priority = (row: DirectoryEntry) => sameSic(row)
        ? (row.industry.trim().toLowerCase() === directoryIndustry ? 0 : 1)
        : row.industry.trim().toLowerCase() === directoryIndustry ? 2 : 3;
      const candidateRows = directory.filter(row => sameSic(row) ||
        (directoryIndustry && row.industry.trim().toLowerCase() === directoryIndustry) ||
        (directorySector && row.sector?.trim().toLowerCase() === directorySector))
        .sort((a, b) => priority(a) - priority(b) || a.symbol.localeCompare(b.symbol));
      const candidates = [...new Set(candidateRows.map(row => row.symbol.trim().toUpperCase()).filter(value => value !== symbol && symbolSchema.safeParse(value).success))].filter(ticker => {
        const cik = tickerMap.get(normalizedSymbol(ticker));
        if (!cik || candidateIssuers.has(cik)) return false;
        candidateIssuers.add(cik);
        return true;
      // Bound discovery separately from the eight retained peers: a rejected
      // issuer must not consume a slot that a later comparable company can fill.
      }).slice(0, 24);
      for (const ticker of candidates) {
        if (peers.length >= 8) break;
        const beforeSources = sources.length;
        try {
          const peer = await company(ticker, Number(own.meta.sic));
          if (!peer) continue;
          const price = await getQuote(ticker);
          if (!price) throw new DataUnavailable("缺少 7 日内已保存收盘价");
          const candidate: ReportedPeer = { symbol: ticker, industry, currency: "USD", price: price.price, observedAt: price.observedAt, current: peer.periods.current };
          if (!reportedPeerMultiple(candidate, { symbol, industry, observedAt, sources }))
            throw new DataUnavailable("财报新鲜度、盈利质量或 2–100 倍 P/E 筛选未通过");
          if (new Set(sources.map(source => source.id)).size > 80) throw new DataUnavailable("本轮证据数量预算已用完");
          peers.push(candidate);
        } catch (error) {
          sources.length = beforeSources;
          if (error instanceof SecFundamentalAccessError) throw error;
          warnings.push(`${ticker}: ${error instanceof DataUnavailable ? error.message : "SEC 同行数据不可用"}。`);
        }
      }
      scenario = { current: own.periods.current, prior: own.periods.prior, peers };
      if (peers.length < 3) warnings.push(`${symbol}: 已取得完整同业财报仅 ${peers.length} 家，估值至少需要 3 家通过盈利及倍数筛选的同业。`);
    } catch (error) {
      if (error instanceof SecFundamentalAccessError || error instanceof SecFundamentalConfigurationError) throw error;
      const reason = error instanceof DataUnavailable ? error.message : "SEC 基本面数据不可用";
      isAdr = /ADR|外国发行人/.test(reason);
      warnings.push(`${symbol}: ${reason}。`);
    }
    const current = scenario?.current;
    return inputSchema.parse({ version: 1, symbol, companyName, sector, industry, currency: "USD", isEtf: false, isAdr, observedAt, quote,
      earningsBasis: "gaap-derived-scenario", financials: current ? { fiscalEnd: current.periodEnd, filedAt: current.filedAt, currency: "USD", revenue: current.revenue, netIncome: current.netIncome, operatingIncome: current.operatingIncome, reportedEps: current.netIncome / current.dilutedShares, freeCashFlow: current.operatingCashFlow - current.capex, cash: null, debt: null, dilutedWeightedShares: current.dilutedShares, latestQuarter: { fiscalEnd: current.latestQuarterEnd, filedAt: current.latestQuarterFiledAt, eps: current.latestQuarterEps }, sourceIds: current.sourceIds } : null,
      estimates: [], peers: [], ...(scenario ? { scenario } : {}), sources: [...new Map(sources.map(value => [value.id, value])).values()].slice(0, 80), warnings: [...new Set(warnings)].slice(0, 40) });
  };
}
