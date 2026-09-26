import type { CatalystUniverse, EventInput, EventType, Importance, ProviderResult, SourceHealth } from "./types";
import { alpacaDataSymbol, marketDataSymbol } from "@/lib/data-sources/marketSymbol";
import { collectNasdaqEarnings, collectNewYorkFedBlsCalendar } from "./publicCalendars";

const DAY = 86_400_000;
const NEWS_PAGE_LIMIT = 40;
const SOURCE_BUDGET_MS = 240_000;
const BLS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const BEA_URL = "https://www.bea.gov/news/schedule/full";
const FED_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
type Fetch = typeof fetch;
type Parsed = { events: EventInput[]; rejected: number; recognized: number; pendingDates?: number };
type ProviderEnv = Record<string, string | undefined>;
export type CatalystProviderDependencies = { fetch?: Fetch; env?: ProviderEnv; sleep?: (ms: number) => Promise<void> };

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function text(value: unknown, limit = 500): string {
  return str(value).replace(/<[^>]*>/g, " ").replace(/&#(\d+);/g, (_, n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim().slice(0, limit);
}
function safeUrl(value: unknown, base?: string): string | null {
  try {
    if (!str(value).trim()) return null;
    const url = new URL(str(value), base);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    for (const key of [...url.searchParams.keys()]) if (/key|token|secret|password|signature/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return null; }
}
function iso(value: unknown): string | null {
  const v = str(value);
  // Never silently interpret provider timestamps in the server's local timezone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(v)) return null;
  if (!validDate(v.slice(0, 10))) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function nyDate(date: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(date));
}
function session(at: string | null): EventInput["session"] {
  if (!at) return "unknown";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const part = (kind: string) => parts.find(p => p.type === kind)?.value ?? "";
  if (["Sat", "Sun"].includes(part("weekday"))) return "closed";
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  return minutes < 570 ? "pre" : minutes < 960 ? "regular" : "after";
}
function zonedTime(date: string, hours: number, minutes: number, zone = "America/New_York"): string | null {
  if (!validDate(date) || hours > 23 || hours < 0 || minutes > 59 || minutes < 0) return null;
  try {
    const target = Date.parse(`${date}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00Z`);
    let timestamp = target;
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (let i = 0; i < 3; i++) {
      const parts = formatter.formatToParts(new Date(timestamp));
      const part = (kind: string) => parts.find(p => p.type === kind)?.value ?? "";
      const wall = Date.parse(`${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:00Z`);
      if (wall === target) return new Date(timestamp).toISOString();
      timestamp += target - wall;
    }
    return null; // A nonexistent daylight-saving local time must not be invented.
  } catch { return null; }
}
function inWindow(date: string, now: Date, futureDays = 90): boolean {
  return date >= nyDate(new Date(now.getTime() - 7 * DAY)) && date <= nyDate(new Date(now.getTime() + futureDays * DAY));
}
function symbolList(universe: CatalystUniverse): string[] {
  return [...new Set(universe.symbols.map(x => x.symbol.toUpperCase()).filter(x => /^[A-Z][A-Z0-9.\-]{0,14}$/.test(x)))];
}
function sectorsFor(symbols: string[], universe: CatalystUniverse): string[] {
  return [...new Set(symbols.flatMap(symbol => universe.symbols.filter(x => x.symbol === symbol && x.sectorId).map(x => x.sectorId!)))];
}
function result(id: string, label: string, now: Date, state: SourceHealth["state"], detail: string, events: EventInput[] = []): ProviderResult {
  return { events, health: { id, label, state, checkedAt: now.toISOString(), count: events.length, detail } };
}
class SourceFailure extends Error {}
function safeFailure(error: unknown): string {
  return error instanceof SourceFailure ? error.message : "请求超时、网络失败或来源格式无效";
}
async function request(fetcher: Fetch, url: string | URL, headers: Record<string, string> = {}): Promise<string> {
  try {
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(20_000), redirect: "error", cache: "no-store" });
    if (!response.ok) throw new SourceFailure(`来源返回 HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 5_000_000) throw new SourceFailure("来源响应超出安全读取上限");
    return body;
  } catch (error) {
    throw new SourceFailure(safeFailure(error));
  }
}
async function json(fetcher: Fetch, url: string | URL, headers?: Record<string, string>): Promise<unknown> {
  const body = await request(fetcher, url, headers);
  try { return JSON.parse(body) as unknown; } catch { throw new SourceFailure("来源未返回有效 JSON"); }
}

// These labels identify reported subjects, not sentiment, causality, or expected returns.
export function classifyCatalystHeadline(headline: string): { type: EventType; importance: Importance } {
  const rules: [RegExp, EventType, Importance][] = [
    [/\b(fda|clinical|phase [123]|pdufa|trial results)\b/i, "FDA / Clinical", "high"],
    [/\b(acquisition|acquire[sd]?|merger|takeover)\b/i, "M&A", "high"],
    [/\b(guidance|outlook|forecast)\b/i, "Guidance", "high"],
    [/\b(earnings|quarterly results|financial results|eps)\b/i, "Earnings", "high"],
    [/\b(bankruptcy|lawsuit|litigation|court|settlement)\b/i, "Legal", "high"],
    [/\b(regulator|antitrust|sec investigation|export control|tariff)\b/i, "Regulatory", "high"],
    [/\b(offering|financing|convertible|debt issuance)\b/i, "Capital / Financing", "medium"],
    [/\b(buyback|repurchase)\b/i, "Buyback", "medium"],
    [/\bdividend\b/i, "Dividend", "medium"],
    [/\b(launch|unveil|new product)\b/i, "Product", "medium"],
    [/\b(conference|investor day)\b/i, "Conference", "medium"],
    [/\b(ceo|chief executive|board|restructur)\b/i, "Corporate", "medium"],
  ];
  const found = rules.find(([pattern]) => pattern.test(headline));
  return found ? { type: found[1], importance: found[2] } : { type: "Other", importance: "low" };
}

async function alpaca(universe: CatalystUniverse, now: Date, fetcher: Fetch, env: ProviderEnv): Promise<ProviderResult> {
  const id = "alpaca-news", label = "Alpaca 新闻";
  const key = env.ALPACA_API_KEY || env.APCA_API_KEY_ID, secret = env.ALPACA_API_SECRET || env.APCA_API_SECRET_KEY;
  if (!key || !secret) return result(id, label, now, "disabled", "未配置 Alpaca 新闻凭据");
  const allSymbols = symbolList(universe), selected = allSymbols;
  if (!selected.length) return result(id, label, now, "disabled", "观察股票池为空，未查询新闻");
  const events = new Map<string, EventInput>();
  let token: string | null = null, skipped = 0, pages = 0;
  const deadline = Date.now() + SOURCE_BUDGET_MS, tokens = new Set<string>();
  const cutoff = new Date(now.getTime() - 15 * 60_000); // Also works with delayed-news subscriptions.
  try {
    for (; pages < NEWS_PAGE_LIMIT && Date.now() < deadline; pages++) {
      const url = new URL("https://data.alpaca.markets/v1beta1/news");
      url.searchParams.set("symbols", [...new Set(selected.map(alpacaDataSymbol))].join(","));
      url.searchParams.set("start", new Date(now.getTime() - 7 * DAY).toISOString());
      url.searchParams.set("end", cutoff.toISOString());
      url.searchParams.set("sort", "desc"); url.searchParams.set("limit", "50"); url.searchParams.set("include_content", "false");
      if (token) url.searchParams.set("page_token", token);
      const body = obj(await json(fetcher, url, { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }));
      if (!body || !Array.isArray(body.news)) throw new SourceFailure("新闻响应缺少 news 列表");
      for (const item of body.news) {
        const row = obj(item), publishedAt = iso(row?.created_at), sourceUrl = safeUrl(row?.url), title = text(row?.headline, 300);
        if (!row || !publishedAt || !sourceUrl || !title || (typeof row.id !== "number" && typeof row.id !== "string")) { skipped++; continue; }
        const sourceSymbols = Array.isArray(row.symbols) ? row.symbols.map(str).map(s => s.toUpperCase()) : [];
        const symbols = selected.filter(s => sourceSymbols.includes(s) || sourceSymbols.includes(alpacaDataSymbol(s)));
        if (!symbols.length || publishedAt > cutoff.toISOString() || !inWindow(nyDate(publishedAt), now, 0)) continue;
        const externalId = String(row.id);
        events.set(externalId, {
          provider: id, externalId, sourceName: text(row.source, 80) || "Alpaca News", sourceUrl,
          title, excerpt: text(row.summary, 360), ...classifyCatalystHeadline(title), symbols, sectorIds: sectorsFor(symbols, universe), scope: "stock",
          publishedAt, eventAt: publishedAt, eventDate: nyDate(publishedAt), timePrecision: "minute", session: session(publishedAt),
          timing: "confirmed", status: "published", sourceUpdatedAt: iso(row.updated_at),
        });
      }
      token = str(body.next_page_token) || null;
      if (!token) { pages++; break; }
      if (tokens.has(token)) throw new SourceFailure("新闻分页令牌重复，覆盖尚未完成");
      tokens.add(token);
    }
    const partial = Boolean(token) || skipped > 0 || allSymbols.length > selected.length;
    return result(id, label, now, partial ? "partial" : "ok", `最近 7 日；截至 ${cutoff.toISOString()}（预留 15 分钟延迟）；覆盖当前观察池 ${selected.length}/${allSymbols.length} 只股票、${pages} 页${token ? `；达到 ${NEWS_PAGE_LIMIT} 页或 4 分钟采集预算，尚有新闻未读取` : "；已读至最后一页"}${skipped ? `；${skipped} 条字段无效未采用` : ""}`, [...events.values()]);
  } catch (error) { return result(id, label, now, events.size || pages ? "partial" : "unavailable", safeFailure(error), [...events.values()]); }
}

async function earnings(universe: CatalystUniverse, now: Date, fetcher: Fetch, env: ProviderEnv): Promise<ProviderResult> {
  const id = "fmp-earnings", label = "FMP 财报日历", key = env.FMP_API_KEY;
  if (!key) return collectNasdaqEarnings(universe, now, fetcher);
  const symbols = symbolList(universe);
  if (!symbols.length) return result(id, label, now, "disabled", "观察股票池为空，未查询财报日历");
  try {
    const from = nyDate(now), to = nyDate(new Date(now.getTime() + 7 * DAY));
    const url = new URL("https://financialmodelingprep.com/stable/earnings-calendar");
    url.searchParams.set("from", from); url.searchParams.set("to", to);
    const publicUrl = url.toString(); url.searchParams.set("apikey", key);
    const body = await json(fetcher, url);
    if (!Array.isArray(body)) throw new SourceFailure("财报日历响应不是事件列表（可能无接口权限）");
    const events: EventInput[] = []; let rejected = 0;
    for (const item of body) {
      const row = obj(item), sourceSymbol = str(row?.symbol).toUpperCase().replace(/\./g, "-");
      const symbol = symbols.find(s => s.replace(/\./g, "-") === sourceSymbol || marketDataSymbol(s).replace(/\./g, "-") === sourceSymbol);
      if (!symbol) continue;
      const date = str(row?.date);
      if (!validDate(date)) { rejected++; continue; }
      if (date < from || date > to) continue;
      const time = str(row?.time).toLowerCase(), period = time === "bmo" ? "pre" : time === "amc" ? "after" : "unknown";
      events.push({
        provider: id, externalId: `${symbol}:${date}`, sourceName: "Financial Modeling Prep", sourceUrl: publicUrl,
        title: `${symbol} 财报日历`, excerpt: "第三方日历记录；日期与时段以公司最终公告为准，未读取或推断财报结果。", type: "Earnings", importance: "high",
        symbols: [symbol], sectorIds: sectorsFor([symbol], universe), scope: "stock", publishedAt: null, eventAt: null, eventDate: date,
        timePrecision: period === "unknown" ? "date" : "session", session: period, timing: "estimated", status: "scheduled", sourceUpdatedAt: iso(row?.lastUpdated),
      });
    }
    return result(id, label, now, rejected ? "partial" : "ok", `未来 7 日；仅关联观察池；日期为第三方预计值${rejected ? `；${rejected} 条日期无效` : ""}`, events);
  } catch (error) { return result(id, label, now, "unavailable", safeFailure(error)); }
}

function macroEvent(provider: string, sourceName: string, sourceUrl: string, externalId: string, title: string, date: string, at: string | null): EventInput {
  return {
    provider, sourceName, sourceUrl, externalId, title, excerpt: "官方日历安排；计划时间不代表数据或决定已经发布。", type: "Macro", importance: /consumer price|employment situation|producer price|personal income|gdp|fomc/i.test(title) ? "high" : "medium",
    symbols: [], sectorIds: [], scope: "market", publishedAt: null, eventAt: at, eventDate: date,
    timePrecision: at ? "minute" : "date", session: session(at), timing: "confirmed", status: "scheduled", sourceUpdatedAt: null,
  };
}
function icsValue(raw: string): string { return raw.replace(/\\[nN]/g, " ").replace(/\\([,;\\])/g, "$1"); }

export function parseBlsCalendar(body: string, now: Date): Parsed {
  if (!/BEGIN:VCALENDAR/.test(body) || !/END:VCALENDAR/.test(body)) throw new SourceFailure("BLS 未返回有效 iCalendar");
  const unfolded = body.replace(/\r?\n[ \t]/g, ""), blocks = [...unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)];
  const parsed: Parsed = { events: [], rejected: 0, recognized: blocks.length };
  for (const block of blocks) {
    const lines = block[1].split(/\r?\n/), get = (name: string) => lines.find(l => l.startsWith(`${name}:`) || l.startsWith(`${name};`)) ?? "";
    const read = (name: string) => icsValue(get(name).replace(/^[^:]*:/, ""));
    const start = get("DTSTART"), dateMatch = start.match(/:(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    const title = text(read("SUMMARY"), 300), uid = read("UID");
    if (!dateMatch || !title) { parsed.rejected++; continue; }
    const date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    if (!validDate(date)) { parsed.rejected++; continue; }
    if (!inWindow(date, now)) continue;
    const zone = start.match(/TZID=([^;:]+)/)?.[1], hasTime = Boolean(dateMatch[4]);
    const knownZone = dateMatch[7] ? "UTC" : zone?.replace(/^"|"$/g, "");
    // Floating DTSTART has no timezone guarantee: retain its date without fabricating a clock time.
    const at = hasTime && knownZone ? zonedTime(date, Number(dateMatch[4]), Number(dateMatch[5]), knownZone) : null;
    const event = macroEvent("bls-calendar", "U.S. Bureau of Labor Statistics", safeUrl(read("URL")) || BLS_URL, uid || `${date}:${title}`, title, date, at);
    if (hasTime && !at) { event.timing = "unknown"; event.excerpt += " 来源时间的时区无法确认，仅展示日期。"; parsed.rejected++; }
    const updated = read("LAST-MODIFIED");
    if (/^\d{8}T\d{6}Z$/.test(updated)) event.sourceUpdatedAt = iso(updated.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
    if (read("STATUS").toUpperCase() === "CANCELLED") event.status = "cancelled";
    parsed.events.push(event);
  }
  if (!blocks.length) throw new SourceFailure("BLS 日历未发现可识别事件，覆盖未知");
  return parsed;
}

function monthNumber(value: string): number { return MONTHS.findIndex(month => month.startsWith(value.toLowerCase())) + 1; }
function calendarDate(year: number, month: string, day: number): string | null {
  const n = monthNumber(month), date = `${year}-${String(n).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return n > 0 && validDate(date) ? date : null;
}
export function parseBeaCalendar(body: string, now: Date): Parsed {
  const tables = [...body.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)], parsed: Parsed = { events: [], rejected: 0, recognized: 0 };
  let currentYearPresent = false;
  for (const [table] of tables) {
    const year = text(table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1]).match(/Year\s+(\d{4})/i)?.[1];
    if (!year) continue;
    if (year === nyDate(now).slice(0, 4)) currentYearPresent = true;
    for (const [row] of table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
      if (!/<td\b[^>]*class=["'][^"']*(?:scheduled-date|release-title)/i.test(row)) continue;
      parsed.recognized++;
      const dateText = text(row.match(/<div\b[^>]*class=["'][^"']*release-date[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
      const title = text(row.match(/<td\b[^>]*class=["'][^"']*release-title[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1], 300);
      const dateParts = dateText.match(/^([A-Za-z]+)\s+(\d{1,2})$/), date = dateParts ? calendarDate(Number(year), dateParts[1], Number(dateParts[2])) : null;
      if (!date && title && /To Be Announced/i.test(text(row))) {
        parsed.pendingDates = (parsed.pendingDates ?? 0) + 1;
        continue; // The official source has not assigned a date; do not fabricate one.
      }
      if (!date || !title) { parsed.rejected++; continue; }
      if (!inWindow(date, now)) continue;
      const time = text(row.match(/<small\b[^>]*>([\s\S]*?)<\/small>/i)?.[1]).match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
      const hour = time ? Number(time[1]) % 12 + (time[3].toUpperCase() === "PM" ? 12 : 0) : null;
      const at = hour !== null && time ? zonedTime(date, hour, Number(time[2])) : null;
      const link = row.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1];
      parsed.events.push(macroEvent("bea-calendar", "U.S. Bureau of Economic Analysis", safeUrl(link, "https://www.bea.gov") || BEA_URL, `${date}:${title}`, title, date, at));
    }
  }
  if (!parsed.recognized) throw new SourceFailure("BEA 日历页面结构无法识别");
  if (!currentYearPresent) throw new SourceFailure("BEA 日历未覆盖当前年份");
  return parsed;
}

export function parseFedCalendar(body: string, now: Date): Parsed {
  const sections = [...body.matchAll(/(\d{4})\s+FOMC Meetings/g)], parsed: Parsed = { events: [], rejected: 0, recognized: 0 };
  if (!sections.some(section => section[1] === nyDate(now).slice(0, 4))) throw new SourceFailure("FOMC 日历未覆盖当前年份");
  for (let index = 0; index < sections.length; index++) {
    const part = body.slice(sections[index].index! + sections[index][0].length, sections[index + 1]?.index ?? body.length), year = Number(sections[index][1]);
    const months = [...part.matchAll(/<div\b[^>]*class=["'][^"']*fomc-meeting__month[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)];
    for (let j = 0; j < months.length; j++) {
      parsed.recognized++;
      const block = part.slice(months[j].index!, months[j + 1]?.index ?? part.length), month = text(months[j][1]).split("/").at(-1)!;
      const dayText = text(block.match(/<div\b[^>]*class=["'][^"']*fomc-meeting__date[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1]);
      const days = dayText.match(/^(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/), date = days ? calendarDate(year, month, Number(days[2] || days[1])) : null;
      if (!date) { parsed.rejected++; continue; }
      if (!inWindow(date, now)) continue;
      const event = macroEvent("fed-calendar", "Federal Reserve", FED_URL, `fomc:${date}`, "FOMC 会议结束日", date, null);
      event.timing = "estimated";
      event.excerpt = `官方会议日历：${text(months[j][1])} ${dayText}；日历仅提供日期，未填入决议发布时间。后续会议日期可能调整。`;
      parsed.events.push(event);
    }
  }
  if (!parsed.recognized) throw new SourceFailure("FOMC 日历页面结构无法识别");
  return parsed;
}

async function calendar(id: string, label: string, url: string, parser: (body: string, now: Date) => Parsed, now: Date, fetcher: Fetch): Promise<ProviderResult> {
  try {
    const parsed = parser(await request(fetcher, url, { "User-Agent": "Trend-Adaptive Catalyst Monitor", Accept: "text/calendar,text/html;q=0.9,*/*;q=0.5" }), now);
    return result(id, label, now, parsed.rejected || parsed.pendingDates ? "partial" : "ok", `官方已公布日期覆盖 ${parsed.events.length} 条；筛选最近 7 日至未来 90 日；仅日程，不代表结果已发布${parsed.pendingDates ? `；另有 ${parsed.pendingDates} 项官方日期待定（To Be Announced），未编造日程` : ""}${parsed.rejected ? `；${parsed.rejected} 项时间或字段不完整` : ""}`, parsed.events);
  } catch (error) {
    if (id === "bls-calendar") return collectNewYorkFedBlsCalendar(now, fetcher, safeFailure(error));
    return result(id, label, now, "unavailable", safeFailure(error));
  }
}

export function parseSecSubmissions(body: unknown, symbol: string, cik: string, universe: CatalystUniverse, now: Date): Parsed {
  const raw = obj(obj(obj(body)?.filings)?.recent);
  if (!raw || !Array.isArray(raw.form) || !Array.isArray(raw.filingDate) || !Array.isArray(raw.accessionNumber)) throw new SourceFailure("SEC 响应缺少近期披露列表");
  const at = (name: string, index: number) => Array.isArray(raw[name]) ? (raw[name] as unknown[])[index] : null;
  const parsed: Parsed = { events: [], rejected: 0, recognized: raw.form.length };
  for (let index = 0; index < raw.form.length; index++) {
    const form = str(at("form", index));
    if (!/^(8-K|6-K)(\/A)?$/.test(form)) continue;
    const date = str(at("filingDate", index));
    if (!validDate(date)) { parsed.rejected++; continue; }
    if (!inWindow(date, now, 0)) continue;
    const accession = str(at("accessionNumber", index)), document = str(at("primaryDocument", index));
    if (!/^\d{10}-\d{2}-\d{6}$/.test(accession) || !/^[\w.\-]+$/.test(document)) { parsed.rejected++; continue; }
    const accepted = iso(at("acceptanceDateTime", index));
    if (accepted && accepted > now.toISOString()) continue;
    const items = str(at("items", index)), itemSet = new Set(items.split(/[,;\s]+/).filter(Boolean));
    // 8-K item 2.02 identifies operating/financial results; other current reports remain corporate filings.
    const type: EventType = itemSet.has("2.02") ? "Earnings" : itemSet.has("2.01") ? "M&A" : itemSet.has("3.02") || itemSet.has("2.03") ? "Capital / Financing" : "Corporate";
    const importance: Importance = type === "Earnings" || type === "M&A" || itemSet.has("1.03") ? "high" : "medium";
    parsed.events.push({
      provider: "sec-filings", externalId: accession, sourceName: "SEC EDGAR", sourceUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${document}`,
      title: `${symbol} · ${form} ${type === "Earnings" ? "经营与财务结果披露" : "公司重大事项披露"}`,
      excerpt: `${form} 已提交${items ? `；Items ${items}` : ""}。分类来自表单与条目；未读取全文，不推断事件方向或财报优劣。`, type, importance,
      symbols: [symbol], sectorIds: sectorsFor([symbol], universe), scope: "stock", publishedAt: accepted, eventAt: accepted, eventDate: accepted ? nyDate(accepted) : date,
      timePrecision: accepted ? "minute" : "date", session: session(accepted), timing: "confirmed", status: "published", sourceUpdatedAt: null,
    });
  }
  return parsed;
}
async function sec(universe: CatalystUniverse, now: Date, fetcher: Fetch, env: ProviderEnv, sleep: (ms: number) => Promise<void>): Promise<ProviderResult> {
  const id = "sec-filings", label = "SEC 公司披露", ua = env.SEC_USER_AGENT?.trim();
  if (!ua || !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(ua) || /example\.(com|org)|\.local(?:\s|$)/i.test(ua)) return result(id, label, now, "disabled", "需配置含真实联系邮箱的 SEC_USER_AGENT");
  const selected = [...universe.symbols].sort((a, b) => {
    const rank = (x: typeof a) => x.relations.some(r => r.kind === "portfolio") ? 0 : x.relations.some(r => r.kind === "signal") ? 1 : 2;
    return rank(a) - rank(b);
  }).filter(x => /^[A-Z][A-Z0-9.\-]{0,14}$/.test(x.symbol));
  if (!selected.length) return result(id, label, now, "disabled", "观察股票池为空，未查询 SEC");
  const events: EventInput[] = []; let completed = 0, failed = 0, unmapped = 0, rejected = 0, stopped = "";
  const deadline = Date.now() + SOURCE_BUDGET_MS;
  try {
    const tickers = obj(await json(fetcher, "https://www.sec.gov/files/company_tickers.json", { "User-Agent": ua, Accept: "application/json" }));
    if (!tickers) throw new SourceFailure("SEC 股票映射格式无效");
    const map = new Map<string, string>();
    for (const value of Object.values(tickers)) {
      const row = obj(value), ticker = str(row?.ticker).toUpperCase(), cik = String(row?.cik_str ?? "");
      if (ticker && /^\d{1,10}$/.test(cik)) map.set(ticker.replace(/-/g, "."), cik.padStart(10, "0"));
    }
    if (!map.size) throw new SourceFailure("SEC 股票映射为空");
    const companies = new Map<string, typeof selected>();
    for (const stock of selected) {
      const cik = map.get(marketDataSymbol(stock.symbol).replace(/-/g, ".")) || map.get(stock.symbol.replace(/-/g, "."));
      if (!cik) { unmapped++; continue; }
      const group = companies.get(cik) ?? [];
      group.push(stock); companies.set(cik, group);
    }
    // Multiple listed share classes belong to one issuer/filing; keep every observed relation.
    for (const [cik, stocks] of companies) {
      if (Date.now() >= deadline) { stopped = "4 分钟采集预算已用完"; break; }
      await sleep(150); // Respect SEC's documented 10 requests/second ceiling.
      try {
        const parsed = parseSecSubmissions(await json(fetcher, `https://data.sec.gov/submissions/CIK${cik}.json`, { "User-Agent": ua, Accept: "application/json" }), stocks[0].symbol, cik, universe, now);
        const symbols = stocks.map(stock => stock.symbol);
        completed += stocks.length; rejected += parsed.rejected;
        events.push(...parsed.events.map(event => ({ ...event, symbols, sectorIds: sectorsFor(symbols, universe), title: `${symbols.join(" / ")}${event.title.slice(stocks[0].symbol.length)}` })));
      } catch (error) {
        failed += stocks.length;
        if (error instanceof SourceFailure && /HTTP (403|429)\b/.test(error.message)) { stopped = `${safeFailure(error)}，停止后续查询`; break; }
      }
    }
    const remaining = selected.length - completed - failed - unmapped;
    const partial = failed > 0 || unmapped > 0 || rejected > 0 || remaining > 0 || universe.symbols.length > selected.length;
    return result(id, label, now, completed ? partial ? "partial" : "ok" : "unavailable", `最近 7 日 8-K/6-K；按持仓、信号、机会池顺序查询，同发行人合并请求；成功 ${completed}/${selected.length} 只（全池 ${universe.symbols.length} 只）${stopped ? `；${stopped}` : ""}${remaining ? `；${remaining} 只尚未查询` : ""}${failed ? `；${failed} 只查询失败` : ""}${unmapped ? `；${unmapped} 只无 CIK 映射` : ""}${rejected ? `；${rejected} 条字段无效` : ""}`, events);
  } catch (error) { return result(id, label, now, events.length ? "partial" : "unavailable", safeFailure(error), events); }
}

/** Read-only collection. Every source reports its own coverage/failure; no model or push delivery. */
export async function collectCatalystSources(universe: CatalystUniverse, now: Date, dependencies: CatalystProviderDependencies = {}): Promise<ProviderResult[]> {
  const fetcher = dependencies.fetch ?? fetch, env = dependencies.env ?? process.env, sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return Promise.all([
    alpaca(universe, now, fetcher, env),
    earnings(universe, now, fetcher, env),
    calendar("bls-calendar", "BLS 经济日历", BLS_URL, parseBlsCalendar, now, fetcher),
    calendar("bea-calendar", "BEA 经济日历", BEA_URL, parseBeaCalendar, now, fetcher),
    calendar("fed-calendar", "FOMC 会议日历", FED_URL, parseFedCalendar, now, fetcher),
    sec(universe, now, fetcher, env, sleep),
  ]);
}
