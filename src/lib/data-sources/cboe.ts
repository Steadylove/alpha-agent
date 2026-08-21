import type { DailyBar } from "@/lib/types/market";

const SKEW_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices/SKEW_History.csv";
const VIX_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv";

async function fetchCsv(url: string): Promise<string[][] | null> {
  let response: Response;
  try {
    response = await fetch(url, { next: { revalidate: 6 * 60 * 60 } });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const text = await response.text();
  return text
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(",").map((cell) => cell.trim()));
}

/** CBOE 波动率指数代码。VIX9D/VIX3M 构成 MPR 的 F2 隐波期限结构。 */
export type CboeVolIndex = "VIX" | "VIX9D" | "VIX3M" | "VIX6M";

const cboeHistoryUrl = (index: CboeVolIndex) =>
  `https://cdn.cboe.com/api/global/us_indices/daily_prices/${index}_History.csv`;

/** MM/DD/YYYY -> YYYY-MM-DD */
function toIsoDate(raw: string): string | null {
  const parts = raw.split("/");
  if (parts.length !== 3) return null;
  const [month, day, year] = parts;
  if (year.length !== 4) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * 拉取波动率指数全历史日线（VIX 自 1990、VIX3M 自 2009、VIX9D 自 2011）。
 * 指数无成交量，volume 恒为 0。
 */
export async function fetchCboeVolIndexHistory(index: CboeVolIndex): Promise<DailyBar[]> {
  const rows = await fetchCsv(cboeHistoryUrl(index));
  if (!rows) {
    throw new Error(`CBOE history request failed for ${index}`);
  }

  return rows
    .map((cells): DailyBar | null => {
      const date = toIsoDate(cells[0] ?? "");
      const close = Number(cells[4]);

      if (date == null || !Number.isFinite(close) || close <= 0) {
        return null;
      }

      const open = Number(cells[1]);
      const high = Number(cells[2]);
      const low = Number(cells[3]);

      return {
        symbol: index,
        date,
        open: Number.isFinite(open) && open > 0 ? open : close,
        high: Number.isFinite(high) && high > 0 ? high : close,
        low: Number.isFinite(low) && low > 0 ? low : close,
        close,
        volume: 0,
        source: "cboe",
      };
    })
    .filter((bar): bar is DailyBar => bar !== null);
}

export async function fetchLatestSkew(): Promise<number | null> {
  const rows = await fetchCsv(SKEW_URL);
  if (!rows || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  const value = Number(last[1]);
  return Number.isFinite(value) ? value : null;
}

export async function fetchLatestVix(): Promise<number | null> {
  const rows = await fetchCsv(VIX_URL);
  if (!rows || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  // VIX CSV columns: DATE,OPEN,HIGH,LOW,CLOSE
  const close = Number(last[4]);
  return Number.isFinite(close) ? close : null;
}

/**
 * 白皮书 SKEW 打分（尾部黑天鹅监控）
 * - SKEW < 130 (平静)：25 分
 * - SKEW 130~145 (警戒)：15 分
 * - SKEW > 145 (黑天鹅避险狂飙)：0 分
 */
export function scoreSkew(skew: number | null): number | null {
  if (skew == null) return null;
  if (skew < 130) return 25;
  if (skew <= 145) return 15;
  return 0;
}

/**
 * VIX 作为 0DTE PCR 的可行替代（同属风险偏好/恐慌维度）
 * - VIX < 18 (健康中性)：25 分
 * - VIX 18~25 (警戒)：15 分
 * - VIX 25~35 (恐慌对冲过热)：10 分
 * - VIX > 35 (极度恐慌)：0 分
 */
export function scoreVix(vix: number | null): number | null {
  if (vix == null) return null;
  if (vix < 18) return 25;
  if (vix <= 25) return 15;
  if (vix <= 35) return 10;
  return 0;
}
