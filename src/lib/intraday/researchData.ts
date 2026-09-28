import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import path from "node:path";
import { alpacaCredentials } from "@/lib/data-sources/alpaca";
import type { Bar, DataManifest, Quote, SymbolData } from "./researchTypes";

export const researchRoot = () => path.resolve(process.cwd(), "data/intraday-research");
export const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export function writeJson(file: string, value: unknown, compressed = false) {
  mkdirSync(path.dirname(file), { recursive: true });
  const raw = Buffer.from(JSON.stringify(value));
  const body = compressed ? gzipSync(raw) : raw;
  const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, body); renameSync(temp, file);
  return hash(body);
}
export function readJson<T>(file: string): T {
  const raw = readFileSync(file); return JSON.parse((file.endsWith(".gz") ? gunzipSync(raw) : raw).toString()) as T;
}
const offsets = new Map<number, number>();
const nyHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });
export function eastern(t: number) {
  const day = Math.floor(t / 86400000);
  let offset = offsets.get(day);
  // US session bars are after the DST transition; reference noon UTC is safe for these data.
  if (offset === undefined) { offset = Number(nyHour.format(new Date(day * 86400000 + 43200000))) - 12; offsets.set(day, offset); }
  const shifted = new Date(t + offset * 3600000);
  return { date: shifted.toISOString().slice(0, 10), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(), weekday: shifted.getUTCDay() };
}
export const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export function easternMidnight(date: string) {
  const noon=Date.parse(`${date}T12:00:00Z`);
  const offset=Number(nyHour.format(noon))-12;
  return Date.parse(`${date}T00:00:00Z`)-offset*3600000;
}
export function parseUniverse(file: string): string[] {
  const list = readFileSync(file, "utf8").trim().split(/[\s,]+/).filter(Boolean);
  if (!list.length || list.some(s => !/^(NASDAQ|NYSE|AMEX):[A-Z]{1,5}$/.test(s)) || new Set(list).size !== list.length) throw new Error("股票池必须是去重后的交易所:代码 TXT");
  return list.sort();
}
type VendorBar = { t: string; o: number; h: number; l: number; c: number; v: number };
export function convertBar(b: VendorBar): Bar {
  const result = { ...b, t: Date.parse(b.t) };
  if (![result.t, b.o, b.h, b.l, b.c, b.v].every(Number.isFinite) || Math.min(b.o,b.h,b.l,b.c) <= 0 || b.v < 0 || b.h < Math.max(b.o,b.l,b.c) || b.l > Math.min(b.o,b.h,b.c)) throw new Error("行情中存在无效 OHLCV");
  return result;
}
async function request<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const { key, secret } = alpacaCredentials();
  const url = new URL(`https://data.alpaca.markets/v2/stocks/${endpoint}`); url.search = new URLSearchParams(params).toString();
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(url, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, signal: AbortSignal.timeout(45000) });
      if (r.ok) return await r.json() as T;
      if (r.status !== 429 && r.status < 500) throw new Error(`SIP ${endpoint} HTTP ${r.status}（未降级数据源）`);
      if (attempt === 5) throw new Error(`SIP ${endpoint} HTTP ${r.status}，重试耗尽`);
      const reset = Number(r.headers.get("x-ratelimit-reset")) * 1000 - Date.now();
      await new Promise(resolve => setTimeout(resolve, r.status === 429 ? Math.min(60000, Math.max(15000, reset || 30000)) : Math.min(15000, 1000 * 2 ** attempt)));
    } catch (e) {
      if (e instanceof Error && /HTTP/.test(e.message)) throw e;
      if (attempt === 5) throw new Error("SIP 网络请求失败，未完成分区保留为失败");
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw new Error("unreachable");
}
export async function fetchBars(symbols: string[], timeframe: "1Min" | "1Day", from: string, to: string, adjustment: "raw" | "split" = "raw") {
  const result: Record<string, Bar[]> = {}; let token: string | null = null;
  const begin=timeframe==="1Min"?easternMidnight(from):Date.parse(`${from}T00:00:00Z`);
  const end=timeframe==="1Min"?easternMidnight(to):Date.parse(`${to}T00:00:00Z`);
  const seen = new Set<string>();
  do {
    const page: { bars: Record<string, VendorBar[]> | null; next_page_token: string | null } = await request("bars", {
      symbols: symbols.join(","), timeframe, start: new Date(begin).toISOString(), end: new Date(end).toISOString(), feed: "sip", adjustment, asof: to, limit: "10000", sort: "asc", ...(token ? { page_token: token } : {}),
    });
    for (const [s, bars] of Object.entries(page.bars ?? {})) {
      const target = result[s] ??= [];
      for (const raw of bars) {
        const b = convertBar(raw); const date = eastern(b.t);
        if (timeframe === "1Min" && (date.minute < 240 || date.minute >= 1200 || date.weekday === 0 || date.weekday === 6)) continue;
        if (b.t < begin || b.t >= end) continue;
        if (target.at(-1)?.t === b.t) { if (JSON.stringify(target.at(-1)) !== JSON.stringify(b)) throw new Error("重复 K 线值冲突"); continue; }
        if (target.at(-1) && target.at(-1)!.t > b.t) throw new Error("K线顺序异常");
        target.push(b);
      }
    }
    token = page.next_page_token;
    if (token) { if (seen.has(token)) throw new Error("行情分页重复"); seen.add(token); }
  } while (token);
  return result;
}
export const manifestFile = (id: string) => path.join(researchRoot(), "datasets", safeId(id), "manifest.json");
export const symbolFile = (id: string, symbol: string) => path.join(researchRoot(), "datasets", safeId(id), `${symbol.replace(":", "-")}.json.gz`);
export function safeId(id: string) { if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error("无效研究版本"); return id; }
export async function downloadUniverse(universe: string[], sessions = 20, end = eastern(Date.now() - 86400000).date, log: (s: string) => void = console.log) {
  const to = shiftDate(end, 1);
  if (Date.parse(`${to}T00:00:00Z`) > Date.now() - 20 * 60000) throw new Error("只采集已结束交易日；请选择更早的结束日期");
  const spy = (await fetchBars(["SPY"], "1Day", shiftDate(end, -Math.max(120, sessions * 2)), to)).SPY ?? [];
  const calendar = [...new Set(spy.map(b => eastern(b.t).date))].filter(d => d <= end).sort().slice(-sessions);
  if (calendar.length !== sessions) throw new Error("交易日日历不足");
  const from = calendar[0], warmupFrom = shiftDate(from, -14), dailyFrom = shiftDate(from, -100);
  const id = `sip-${from}-${calendar.at(-1)}-${hash(universe.join(",")).slice(0, 12)}`;
  const file = manifestFile(id);
  const m: DataManifest = existsSync(file) ? readJson(file) : { version: 1, id, createdAt: new Date().toISOString(), from, to: calendar.at(-1)!, warmupFrom, dailyFrom, universe, universeHash: hash(universe.join(",")), sessions: calendar, completed: [], failed: {}, empty: [], checksums: {}, source: "alpaca-sip", adjustment: "raw" };
  writeJson(file, m);
  const todo = universe.filter(s => !m.completed.includes(s) || !existsSync(symbolFile(id, s)) || m.checksums[s] !== hash(readFileSync(symbolFile(id, s))));
  let cursor = 0; const batches: string[][] = []; for (let i=0;i<todo.length;i+=10) batches.push(todo.slice(i,i+10));
  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++]; const symbols = batch.map(s => s.split(":")[1]);
      try {
        const daily = await fetchBars(symbols, "1Day", dailyFrom, to);
        const adjusted = await fetchBars(symbols, "1Day", dailyFrom, to, "split");
        const minutes = await fetchBars(symbols, "1Min", warmupFrom, to);
        for (const s of batch) {
          const bare = s.split(":")[1], d = daily[bare] ?? [], a = new Map((adjusted[bare] ?? []).map(b => [b.t, b]));
          const splitFactors: Record<string, number> = {};
          for (const b of d) { const adj = a.get(b.t); if (adj) splitFactors[eastern(b.t).date] = adj.c / b.c; }
          const value: SymbolData = { symbol: s, bars: minutes[bare] ?? [], daily: d, floats: [], splitFactors };
          m.checksums[s] = writeJson(symbolFile(id, s), value, true);
          if (!m.completed.includes(s)) m.completed.push(s);
          delete m.failed[s];
          m.empty = m.empty.filter(x => x !== s); if (!value.bars.length) m.empty.push(s);
        }
      } catch (error) {
        for (const s of batch) m.failed[s] = error instanceof Error ? error.message : "采集失败";
      }
      writeJson(file, m); log(`${id} ${m.completed.length}/${universe.length} 完成 · ${Object.keys(m.failed).length} 失败`);
    }
  }
  await Promise.all([worker(), worker(), worker()]); return m;
}
export async function fetchQuotes(symbol: string, from: number, to: number): Promise<Quote[]> {
  const result: Quote[] = []; let token: string | null = null; const seen = new Set<string>();
  do {
    const page: { quotes: Record<string, { t: string; bp: number; ap: number; bs: number; as: number }[]> | null; next_page_token: string | null } = await request("quotes", { symbols: symbol.split(":")[1], start: new Date(from).toISOString(), end: new Date(to).toISOString(), feed: "sip", limit: "10000", sort: "asc", ...(token ? { page_token: token } : {}) });
    for (const q of Object.values(page.quotes ?? {}).flat()) {
      const value = { t: Date.parse(q.t), bid: q.bp, ask: q.ap, bidSize: q.bs, askSize: q.as };
      if (Object.values(value).every(Number.isFinite) && value.t <= to && value.t >= from) result.push(value);
    }
    token = page.next_page_token;
    if (token) { if(seen.has(token)) throw new Error("报价分页重复"); seen.add(token); }
  } while(token);
  return result;
}
