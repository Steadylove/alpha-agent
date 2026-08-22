/**
 * FINRA 合并空头持仓（Consolidated Short Interest）。
 *
 * 免费、无需鉴权，覆盖全部美国上市证券（实测某一结算日 22341 只，
 * 轮动池 40 只一只不缺）。这是 Pine 的 `request.financial(..., "SHORT_INTEREST", "FQ")`
 * 在本项目里的替代——而且更新鲜：Pine 用的是季度口径，FINRA 是双月度。
 *
 * ## 发布节奏
 *
 * 每月 15 日与月末两个结算日，结算后第 7 个交易日发布，因此常态滞后约 2~3 周。
 * 这是数据源的固有属性，不是实现缺陷。
 *
 * ## 查询限制
 *
 * - 单次最多 5000 条，靠 `offset` 翻页
 * - 排序要求把分区键 `settlementDate` 用 EQUAL 过滤，否则 400；
 *   所以这里改用日期区间取回若干期，在内存里挑最新的一期
 */

const FINRA_URL = "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest";

/** 回看窗口，需覆盖「最近一期尚未发布」的情况，两个月足够拿到至少两期。 */
const LOOKBACK_DAYS = 75;

export type ShortInterestRecord = {
  symbol: string;
  /** 该期的结算日，YYYY-MM-DD */
  settlementDate: string;
  /** 空头持仓股数 */
  sharesShort: number;
};

type FinraRow = {
  symbolCode?: string;
  settlementDate?: string;
  currentShortPositionQuantity?: string | number;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * 批量取各标的最近一期空头持仓。
 *
 * 按结算日整批拉取而非逐只查询：一次请求覆盖全市场，40 只标的分 40 次查
 * 反而更慢也更容易触发限流。
 */
export async function fetchLatestShortInterest(
  symbols: readonly string[],
): Promise<Map<string, ShortInterestRecord>> {
  const wanted = new Set(symbols);
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const best = new Map<string, ShortInterestRecord>();
  let offset = 0;

  for (;;) {
    const res = await fetch(FINRA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        dateRangeFilters: [
          { fieldName: "settlementDate", startDate: iso(startDate), endDate: iso(endDate) },
        ],
        limit: 5000,
        offset,
      }),
    });
    if (!res.ok) {
      throw new Error(`FINRA ${res.status}: ${await res.text()}`);
    }

    const rows = (await res.json()) as FinraRow[];
    if (rows.length === 0) break;

    for (const r of rows) {
      const symbol = r.symbolCode;
      const settlementDate = r.settlementDate;
      if (!symbol || !settlementDate || !wanted.has(symbol)) continue;

      const sharesShort = Number(r.currentShortPositionQuantity);
      if (!Number.isFinite(sharesShort)) continue;

      // 窗口里有多期，只留最新
      const prev = best.get(symbol);
      if (!prev || settlementDate > prev.settlementDate) {
        best.set(symbol, { symbol, settlementDate, sharesShort });
      }
    }

    offset += rows.length;
    if (rows.length < 5000) break;
  }

  return best;
}
