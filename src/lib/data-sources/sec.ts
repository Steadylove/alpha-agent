/**
 * SEC XBRL —— 免费的在外流通股本。
 *
 * 用途仅限空头占比的分母。FMP 当前订阅对中小盘返回
 * 「Premium Query Parameter」，`shares-float` 与 income statement 的
 * `weightedAverageShsOutDil` 对轮动池里 20 多只标的都取不到，
 * 而这些恰好是空头占比最高的票，缺了等于这项功能白做。
 *
 * 注意这与 `StockFundamentals.sharesOutstanding` 不是同一口径：后者是
 * 加权平均稀释股本（估值分支门槛用，且在 PS/PE 模型里会被约掉、不影响数值），
 * 这里优先取封面页的实际在外股数，才是空头占比该用的分母。
 *
 * ## 两个坑
 *
 * - SEC 在概念不存在时返回 **HTTP 200 但 body 是 XML** 的 NoSuchKey 错误，
 *   不能只看 `res.ok`，必须容错解析
 * - 多类别股公司（META、GOOG 这种 A/B 股）不报封面页合计，
 *   companyfacts 里只有加权平均稀释股本，只能退而求其次
 *
 * SEC 要求带 User-Agent，否则 403。
 */

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_CONCEPT_BASE = "https://data.sec.gov/api/xbrl/companyconcept";
const SEC_FACTS_BASE = "https://data.sec.gov/api/xbrl/companyfacts";

/** SEC 要求可联系到的标识，不带会被 403。 */
const USER_AGENT = process.env.SEC_USER_AGENT ?? "alpha-agent research admin@alpha-agent.local";

/** 每秒 10 次是 SEC 的公开上限，留出余量。 */
const REQUEST_GAP_MS = 120;

/** 轻量路径：单概念接口只有几十 KB。 */
const CONCEPTS = [
  "dei/EntityCommonStockSharesOutstanding",
  "us-gaap/CommonStockSharesOutstanding",
  "us-gaap/CommonStockSharesIssued",
] as const;

/**
 * 回落路径的标签优先级。
 *
 * 末位的加权平均稀释股本是近似值，只在多类别股公司上会用到；
 * 这类公司都是万亿级大盘，空头占比在 1% 上下，离 8% 档差着一个数量级，
 * 近似误差不足以改变档位判定。
 */
const FACT_TAGS = [
  "EntityCommonStockSharesOutstanding",
  "CommonStockSharesOutstanding",
  "CommonStockSharesIssued",
  "WeightedAverageNumberOfDilutedSharesOutstanding",
] as const;

type SharePoint = { val?: number; end?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SEC 会用 200 + XML 表示「没这个概念」，直接 res.json() 会抛。 */
async function safeJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  await sleep(REQUEST_GAP_MS);
  if (!res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function latestValue(points: unknown): number | null {
  if (!Array.isArray(points)) return null;
  const valid = (points as SharePoint[]).filter(
    (p): p is { val: number; end: string } =>
      typeof p?.val === "number" && typeof p?.end === "string",
  );
  if (valid.length === 0) return null;
  valid.sort((a, b) => a.end.localeCompare(b.end));
  return valid.at(-1)!.val;
}

export async function fetchSecTickerCikMap(): Promise<Map<string, string>> {
  const raw = await safeJson<Record<string, { ticker?: string; cik_str?: number }>>(
    SEC_TICKERS_URL,
  );
  if (!raw) throw new Error("SEC ticker 表拉取失败");

  const map = new Map<string, string>();
  for (const v of Object.values(raw)) {
    if (v.ticker && v.cik_str != null) {
      map.set(v.ticker, String(v.cik_str).padStart(10, "0"));
    }
  }
  return map;
}

/** 某公司最新一期在外股数；全部口径都取不到时返回 null（ETF 即属此类）。 */
export async function fetchSecSharesOutstanding(cik: string): Promise<number | null> {
  for (const concept of CONCEPTS) {
    const data = await safeJson<{ units?: Record<string, unknown> }>(
      `${SEC_CONCEPT_BASE}/CIK${cik}/${concept}.json`,
    );
    const value = latestValue(data?.units?.shares);
    if (value != null && value > 0) return value;
  }

  // 3MB 级的全量事实表，只在轻量路径全空时才拉
  const facts = await safeJson<{
    facts?: Record<string, Record<string, { units?: Record<string, unknown> }>>;
  }>(`${SEC_FACTS_BASE}/CIK${cik}.json`);
  if (!facts?.facts) return null;

  for (const tag of FACT_TAGS) {
    for (const taxonomy of Object.values(facts.facts)) {
      const value = latestValue(taxonomy?.[tag]?.units?.shares);
      if (value != null && value > 0) return value;
    }
  }
  return null;
}
