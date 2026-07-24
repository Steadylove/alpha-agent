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
    .map((line) => line.split(","));
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
