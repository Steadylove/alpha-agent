import { marketDataSymbol } from "@/lib/data-sources/marketSymbol";
import type { CatalystUniverse, EventInput, ProviderResult } from "./types";

const DAY = 86_400_000;
const NASDAQ_ID = "nasdaq-earnings";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
type Parsed = { events: EventInput[]; recognized: number; rejected: number };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function newYorkDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function nasdaqDate(value: unknown): string | null {
  // The response's asOf is the requested calendar day, not the collection timestamp.
  const match = string(value).match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase()) + 1;
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
  return month && validDate(date) ? date : null;
}

/** Nasdaq's public calendar is an estimate, including its pre-/after-market labels. */
export function parseNasdaqEarningsCalendar(body: unknown, requestedDate: string, universe: CatalystUniverse): Parsed {
  const root = record(body), data = record(root?.data), status = record(root?.status);
  if (status?.rCode !== 200 || !data || nasdaqDate(data.asOf) !== requestedDate || !validDate(requestedDate)) {
    throw new Error("Nasdaq 财报日历状态或返回日期无法确认");
  }
  // An explicit successful dated response with rows:null is Nasdaq's empty-day format.
  if (data.rows === null) return { events: [], recognized: 0, rejected: 0 };
  if (!Array.isArray(data.rows) || data.rows.length > 2_000) throw new Error("Nasdaq 财报日历列表格式无效");
  const parsed: Parsed = { events: [], recognized: data.rows.length, rejected: 0 };
  const symbols = universe.symbols.map(stock => stock.symbol).filter(symbol => /^[A-Z][A-Z0-9.\-]{0,14}$/.test(symbol));
  const canonical = (value: string) => value.toUpperCase().replace(/\./g, "-");
  const seen = new Set<string>();
  for (const item of data.rows) {
    const row = record(item), rawSymbol = string(row?.symbol).toUpperCase();
    if (!row || !/^[A-Z][A-Z0-9.\-]{0,14}$/.test(rawSymbol)) { parsed.rejected++; continue; }
    const symbol = symbols.find(value => canonical(value) === canonical(rawSymbol) || canonical(marketDataSymbol(value)) === canonical(rawSymbol));
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const period = row.time === "time-pre-market" ? "pre" : row.time === "time-after-hours" ? "after" : "unknown";
    parsed.events.push({
      provider: NASDAQ_ID, externalId: `${symbol}:${requestedDate}`, sourceName: "Nasdaq Earnings Calendar / Zacks",
      sourceUrl: `https://api.nasdaq.com/api/calendar/earnings?date=${requestedDate}`,
      title: `${symbol} 财报日历（预计）`, excerpt: "Nasdaq / Zacks 预计日程，可能依据历史报告日期推算，并非公司确认公告。仅使用来源给出的日期与盘前／盘后时段；以公司最终公告为准，不推断财报结果。",
      type: "Earnings", importance: "high", symbols: [symbol], scope: "stock",
      sectorIds: [...new Set(universe.symbols.filter(stock => stock.symbol === symbol && stock.sectorId).map(stock => stock.sectorId!))],
      publishedAt: null, eventAt: null, eventDate: requestedDate, timePrecision: period === "unknown" ? "date" : "session", session: period,
      timing: "estimated", status: "scheduled", sourceUpdatedAt: null,
    });
  }
  return parsed;
}

/** Eight calendar dates at most (today through day +7); no account or paid credential. */
export async function collectNasdaqEarnings(universe: CatalystUniverse, now: Date, fetcher: typeof fetch = fetch): Promise<ProviderResult> {
  const events: EventInput[] = [];
  const health: ProviderResult["health"] = { id: NASDAQ_ID, label: "Nasdaq 财报日历（预计）", checkedAt: now.toISOString(), state: "disabled", count: 0, detail: "观察股票池为空，未查询财报日历" };
  if (!universe.symbols.length) return { events, health };
  const start = newYorkDate(now), startAt = Date.parse(`${start}T00:00:00Z`);
  const days = Array.from({ length: 8 }, (_, index) => new Date(startAt + index * DAY).toISOString().slice(0, 10));
  let completed = 0, rejected = 0, failed = 0, stopped = false;
  const statuses = new Set<number>();
  // Two concurrent requests keep the total bounded without a burst against the public service.
  for (let offset = 0; offset < days.length && !stopped; offset += 2) {
    await Promise.all(days.slice(offset, offset + 2).map(async date => {
      try {
        const response = await fetcher(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, {
          headers: { "User-Agent": "Trend-Adaptive Catalyst Monitor", Accept: "application/json" },
          signal: AbortSignal.timeout(20_000), redirect: "error", cache: "no-store",
        });
        if (!response.ok) {
          statuses.add(response.status);
          if (response.status === 403 || response.status === 429) stopped = true;
          throw new Error("upstream unavailable");
        }
        const body = await response.text();
        if (body.length > 5_000_000) throw new Error("response exceeds limit");
        const parsed = parseNasdaqEarningsCalendar(JSON.parse(body) as unknown, date, universe);
        completed++; rejected += parsed.rejected; events.push(...parsed.events);
      } catch { failed++; } // Never expose a response body, query credential, or arbitrary error text.
    }));
  }
  events.sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.externalId.localeCompare(b.externalId));
  health.count = events.length;
  health.state = completed === days.length && rejected === 0 ? "ok" : completed > 0 ? "partial" : "unavailable";
  health.detail = `未来 7 日（含今日 ${start} 至 ${days.at(-1)}）；完成 ${completed}/${days.length} 个日期；仅关联观察池；Nasdaq / Zacks 预计值，非公司确认${failed ? `；${failed} 个日期请求或格式无效` : ""}${rejected ? `；${rejected} 条字段无效未采用` : ""}${statuses.size ? `；HTTP ${[...statuses].sort().join("、")}` : ""}${stopped ? "；来源拒绝或限流后停止后续请求" : ""}`;
  return { events, health };
}

function htmlText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
}
function newYorkTime(date: string, hour: number, minute: number): string | null {
  if (!validDate(date) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const target = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  let timestamp = target;
  for (let index = 0; index < 3; index++) {
    const parts = formatter.formatToParts(new Date(timestamp)), part = (kind: string) => parts.find(value => value.type === kind)?.value ?? "";
    const wall = Date.parse(`${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:00Z`);
    if (wall === target) return new Date(timestamp).toISOString();
    timestamp += target - wall;
  }
  return null;
}
function newYorkFedUrl(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid calendar month");
  return `https://www.newyorkfed.org/research/calendars/i-${MONTHS[Number(month.slice(5)) - 1]}${month.slice(2, 4)}.html`;
}

/** Only the entries linked to BLS, as scheduled by the New York Fed; this is not the full BLS calendar. */
export function parseNewYorkFedBlsCalendar(body: string, expectedMonth: string, now: Date): Parsed {
  const heading = htmlText(body.match(/<td\b[^>]*class=["'][^"']*ts-data-table-head[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "");
  const month = heading.match(/^([A-Za-z]+)\s+(\d{4})$/), monthNumber = month ? MONTHS.indexOf(month[1].slice(0, 3).toLowerCase()) + 1 : 0;
  const actualMonth = month ? `${month[2]}-${String(monthNumber).padStart(2, "0")}` : "";
  const table = body.match(/<table\b[^>]*class=["'][^"']*research-table-1col[^"']*["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (actualMonth !== expectedMonth || !table || !/all Eastern Time/i.test(body)) throw new Error("纽约联储日历月份、时区或结构无法确认");
  const from = newYorkDate(new Date(now.getTime() - 7 * DAY)), to = newYorkDate(new Date(now.getTime() + 90 * DAY));
  const parsed: Parsed = { events: [], recognized: 0, rejected: 0 };
  for (const [cell] of table.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/gi)) {
    const day = cell.match(/<div\b[^>]*>\s*(\d{1,2})(?:\s|<)/i)?.[1];
    const anchors = [...cell.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
    for (let index = 0; index < anchors.length; index++) {
      const anchor = anchors[index];
      let link: URL;
      try { link = new URL(anchor[1]); } catch { continue; }
      if (!/^https?:$/.test(link.protocol) || link.username || link.password || !["bls.gov", "www.bls.gov"].includes(link.hostname)) continue;
      parsed.recognized++;
      const date = day ? `${expectedMonth}-${day.padStart(2, "0")}` : "", title = htmlText(anchor[2]).slice(0, 300);
      if (!validDate(date) || !title) { parsed.rejected++; continue; }
      if (date < from || date > to) continue;
      const tail = htmlText(cell.slice(anchor.index! + anchor[0].length, anchors[index + 1]?.index ?? cell.length));
      const clock = tail.match(/^\((\d{1,2}):(\d{2})\)/), hour = clock ? Number(clock[1]) : null, minute = clock ? Number(clock[2]) : null;
      const at = hour !== null && minute !== null ? newYorkTime(date, hour, minute) : null;
      if (clock && !at) parsed.rejected++;
      const mins = hour === null || minute === null ? null : hour * 60 + minute;
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
      parsed.events.push({
        provider: "bls-calendar", externalId: `nyfed:${date}:${link.pathname}`, sourceName: "Federal Reserve Bank of New York · BLS 日程转录",
        sourceUrl: newYorkFedUrl(expectedMonth), title,
        excerpt: "纽约联储经济指标日历中指向 BLS 的计划发布事项，仅覆盖该日历收录的部分指标。日期与时间为预计安排，可能调整；不是 BLS 直连全集，也不代表结果已经发布。",
        type: "Macro", importance: /consumer price|employment situation|producer price|jolts|job openings/i.test(title) ? "high" : "medium",
        symbols: [], sectorIds: [], scope: "market", publishedAt: null, eventAt: at, eventDate: date,
        timePrecision: at ? "minute" : "date", session: !at || mins === null ? "unknown" : [0, 6].includes(weekday) ? "closed" : mins < 570 ? "pre" : mins < 960 ? "regular" : "after",
        timing: "estimated", status: "scheduled", sourceUpdatedAt: null,
      });
    }
  }
  if (!parsed.recognized) throw new Error("纽约联储日历未找到可核实的 BLS 条目");
  return parsed;
}

/** Public, independent fallback after BLS fails. It must always disclose partial coverage. */
export async function collectNewYorkFedBlsCalendar(now: Date, fetcher: typeof fetch = fetch, primaryDetail = "请求失败"): Promise<ProviderResult> {
  const from = newYorkDate(new Date(now.getTime() - 7 * DAY)), to = newYorkDate(new Date(now.getTime() + 90 * DAY));
  const months: string[] = [];
  let cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.toISOString().slice(0, 7) <= to.slice(0, 7) && months.length < 5) {
    months.push(cursor.toISOString().slice(0, 7)); cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  const events: EventInput[] = [];
  let completed = 0, failed = 0, rejected = 0, stopped = false;
  const statuses = new Set<number>();
  for (let index = 0; index < months.length && !stopped; index += 2) {
    await Promise.all(months.slice(index, index + 2).map(async month => {
      try {
        const response = await fetcher(newYorkFedUrl(month), { headers: { "User-Agent": "Trend-Adaptive Catalyst Monitor", Accept: "text/html" }, signal: AbortSignal.timeout(20_000), redirect: "error", cache: "no-store" });
        if (!response.ok) {
          statuses.add(response.status);
          if (response.status === 403 || response.status === 429) stopped = true;
          throw new Error("upstream unavailable");
        }
        const body = await response.text();
        if (body.length > 5_000_000) throw new Error("response exceeds limit");
        const parsed = parseNewYorkFedBlsCalendar(body, month, now);
        completed++; rejected += parsed.rejected; events.push(...parsed.events);
      } catch { failed++; }
    }));
  }
  events.sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.externalId.localeCompare(b.externalId));
  const primaryStatus = primaryDetail.match(/HTTP (\d{3})/)?.[1];
  return { events, health: {
    id: "bls-calendar", label: "BLS 日程（纽约联储备用）", checkedAt: now.toISOString(), count: events.length, state: completed ? "partial" : "unavailable",
    detail: `BLS 直连${primaryStatus ? ` HTTP ${primaryStatus}` : "请求或格式失败"}；纽约联储官方日历部分指标备用；${from} 至 ${to}，完成 ${completed}/${months.length} 个月；非 BLS 全集，日程为预计${failed ? `；${failed} 个月请求或格式无效` : ""}${rejected ? `；${rejected} 条字段不完整` : ""}${statuses.size ? `；备用 HTTP ${[...statuses].sort().join("、")}` : ""}${stopped ? "；来源拒绝或限流后停止" : ""}`,
  } };
}
