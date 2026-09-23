import { alpacaCredentials } from "./alpaca";
import type { MacroValue } from "@/lib/review/macro";

const RATE_FIELDS = {
  DGS10: "BC_10YEAR",
  DGS2: "BC_2YEAR",
  DFII10: "TC_10YEAR",
} as const;
type RateId = keyof typeof RATE_FIELDS;
const DAY = 86400000;
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
  new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;

/** 只读取财政部 OData 的日期/数值字段；空值及 m:null 不转成 0。 */
export function parseTreasuryXml(xml: string, id: RateId): MacroValue[] {
  if (!/<(?:[\w.-]+:)?feed\b/.test(xml))
    throw new Error("Invalid Treasury XML");
  const values: MacroValue[] = [];
  const field = (block: string, name: string) => {
    const match = block.match(
      new RegExp(
        `<(?:[\\w.-]+:)?${name}\\b([^>]*)>([^<]*)</(?:[\\w.-]+:)?${name}>`,
      ),
    );
    return !match || /\b(?:\w+:)?null\s*=\s*["']true["']/.test(match[1])
      ? ""
      : match[2].trim();
  };
  for (const match of xml.matchAll(
    /<(?:[\w.-]+:)?properties\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?properties>/g,
  )) {
    const date = field(match[1], "NEW_DATE").slice(0, 10);
    const value = field(match[1], RATE_FIELDS[id]);
    if (validDate(date) && value !== "" && Number.isFinite(Number(value)))
      values.push({
        observationDate: date,
        value: Number(value),
        source: `US Treasury / ${RATE_FIELDS[id]}`,
      });
  }
  return values;
}

export async function fetchTreasuryRates(
  until: string,
): Promise<Record<RateId, MacroValue[]>> {
  // 年初同时读上年，保证最近五个交易日及其前值有同源观测。
  const since = new Date(Date.parse(`${until}T00:00:00Z`) - 40 * DAY)
    .toISOString()
    .slice(0, 10);
  const years = [...new Set([since.slice(0, 4), until.slice(0, 4)])];
  const result: Record<RateId, MacroValue[]> = {
    DGS10: [],
    DGS2: [],
    DFII10: [],
  };
  await Promise.all(
    years.flatMap((year) =>
      ["daily_treasury_yield_curve", "daily_treasury_real_yield_curve"].map(
        async (kind) => {
          const url = new URL(
            "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml",
          );
          url.searchParams.set("data", kind);
          url.searchParams.set("field_tdr_date_value", year);
          const response = await fetch(url, {
            signal: AbortSignal.timeout(30000),
            cache: "no-store",
          });
          if (!response.ok) throw new Error(`Treasury HTTP ${response.status}`);
          const xml = await response.text();
          const ids: RateId[] =
            kind === "daily_treasury_yield_curve"
              ? ["DGS10", "DGS2"]
              : ["DFII10"];
          for (const id of ids)
            result[id].push(
              ...parseTreasuryXml(xml, id).filter(
                (r) => r.observationDate <= until,
              ),
            );
        },
      ),
    ),
  );
  return result;
}

/** UTC 自然日，排除尚未结束的日线；固定 Alpaca US 场所，不混用 Yahoo 前值。 */
export async function fetchAlpacaBtc(until: string): Promise<MacroValue[]> {
  const { key, secret } = alpacaCredentials();
  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(
    Date.parse(`${until}T00:00:00Z`) - 40 * DAY,
  ).toISOString();
  const end = new Date(
    Date.parse(`${until}T00:00:00Z`) + DAY - 1,
  ).toISOString();
  const values: MacroValue[] = [];
  let token: string | null = null;
  const tokens = new Set<string>();
  for (let page = 0; page < 10; page++) {
    const url = new URL("https://data.alpaca.markets/v1beta3/crypto/us/bars");
    url.search = new URLSearchParams({
      symbols: "BTC/USD",
      timeframe: "1Day",
      start,
      end,
      limit: "1000",
      sort: "asc",
      ...(token ? { page_token: token } : {}),
    }).toString();
    const response = await fetch(url, {
      headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Alpaca BTC HTTP ${response.status}`);
    const body = (await response.json()) as {
      bars?: Record<string, { t: string; c: number }[]>;
      next_page_token?: string | null;
    };
    const bars = body.bars?.["BTC/USD"];
    if (!Array.isArray(bars)) throw new Error("Invalid Alpaca BTC response");
    for (const row of bars) {
      const stamp = Date.parse(row.t);
      if (
        !Number.isFinite(stamp) ||
        stamp % DAY !== 0 ||
        !Number.isFinite(row.c) ||
        row.c <= 0
      )
        continue;
      const date = new Date(stamp).toISOString().slice(0, 10);
      if (date <= until && date < today && date >= start.slice(0, 10))
        values.push({
          observationDate: date,
          value: row.c,
          source: "Alpaca US / BTC/USD (UTC)",
        });
    }
    token = body.next_page_token ?? null;
    if (!token) return values;
    if (tokens.has(token)) throw new Error("Repeated Alpaca BTC page token");
    tokens.add(token);
  }
  throw new Error("Alpaca BTC pagination limit exceeded");
}

/** 主源未更新时尝试备用；只选更及时的一套数据，避免跨来源计算涨跌幅。 */
export async function freshestMacroValues(
  primary: () => Promise<MacroValue[]>,
  fallback: () => Promise<MacroValue[]>,
  until: string,
): Promise<MacroValue[]> {
  let preferred: MacroValue[] = [];
  let primaryError: unknown;
  try {
    preferred = await primary();
  } catch (error) {
    primaryError = error;
  }
  const latest = (xs: MacroValue[]) =>
    xs.reduce(
      (date, r) =>
        r.observationDate > date && r.observationDate <= until
          ? r.observationDate
          : date,
      "",
    );
  if (latest(preferred) === until) return preferred;
  try {
    const backup = await fallback();
    if (latest(backup) > latest(preferred)) return backup;
  } catch (error) {
    if (!preferred.length)
      throw new Error(
        `主源: ${primaryError instanceof Error ? primaryError.message : "无数据"}；备用: ${error instanceof Error ? error.message : "失败"}`,
      );
  }
  if (!preferred.length) throw new Error("No completed macro observations");
  return preferred;
}
