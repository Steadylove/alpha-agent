import { existsSync, readFileSync, statSync } from "node:fs";
import type { Timeframe } from "./engine";
import { marketBaseUrl, rpsSnapshotFile } from "./marketStore";
import type { SectorSnapshot } from "@/lib/signals/sectorFactor";

export const RPS_SNAPSHOT_PATH = rpsSnapshotFile();
export const RPS_CACHE_MS = 60_000;
export type RpsEntry = { rps: number; asOf: string };
export type RpsCalendar = { from: string; through: string; sessions: string[] };
export type RpsSnapshot = {
  generatedAt: string;
  poolId: string;
  sourceTimeframe?: "1d";
  benchmark?: "SP500";
  calendar?: RpsCalendar;
  sector?: SectorSnapshot;
  timeframes: Partial<Record<Timeframe, Record<string, RpsEntry>>>;
};
export type RpsEvidence = { asOf: string; generatedAt: string; sourceTimeframe: "1d"; benchmark: "SP500" };

export function pickRps(snapshot: RpsSnapshot | null, symbol: string, timeframe: Timeframe): RpsEntry | null {
  if (!snapshot) throw new Error(`RPS 快照缺失：${RPS_SNAPSHOT_PATH}。跑 npm run rps:snapshot。`);
  const table = snapshot.timeframes[timeframe];
  if (!table) throw new Error(`RPS 快照里没有 ${timeframe} 这一档。`);
  return table[symbol] ?? null;
}

let cached: { source: string; snapshot: RpsSnapshot; at: number; mtime?: number; size?: number } | null = null;
let pending: { source: string; task: Promise<RpsSnapshot | null> } | null = null;

/** 配置远程行情时绝不回落构建时打包的旧文件。 */
export function readRpsSnapshot(): RpsSnapshot | null {
  const base = marketBaseUrl();
  if (base) return cached?.source === base && Date.now() - cached.at < RPS_CACHE_MS ? cached.snapshot : null;
  const file = rpsSnapshotFile();
  if (!existsSync(file)) return null;
  const stat = statSync(file);
  if (cached?.source === file && cached.mtime === stat.mtimeMs && cached.size === stat.size && Date.now() - cached.at < RPS_CACHE_MS) return cached.snapshot;
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as RpsSnapshot;
  cached = { source: file, snapshot, at: Date.now(), mtime: stat.mtimeMs, size: stat.size };
  return snapshot;
}

/** 60秒刷新、并发合并；超时/失败不延长旧快照寿命。 */
export async function ensureRpsSnapshot(): Promise<RpsSnapshot | null> {
  const hit = readRpsSnapshot();
  if (hit) return hit;
  const base = marketBaseUrl();
  if (!base) return null;
  if (pending?.source === base) return pending.task;
  const task = (async () => {
    const { fetchMarketText } = await import("./marketRemote");
    const text = await fetchMarketText("rps/rps-latest.json", AbortSignal.timeout(5000));
    if (!text) throw new Error("远程 RPS 快照缺失");
    const snapshot = JSON.parse(text) as RpsSnapshot;
    if (!snapshot?.timeframes || !Number.isFinite(Date.parse(snapshot.generatedAt))) throw new Error("远程 RPS 快照格式无效");
    cached = { source: base, snapshot, at: Date.now() };
    return snapshot;
  })();
  pending = { source: base, task };
  try { return await task; } finally { if (pending?.task === task) pending = null; }
}

export function latestRps(symbol: string, timeframe: Timeframe): RpsEntry | null {
  return pickRps(readRpsSnapshot(), symbol, timeframe);
}

export function resolveAlertTimeframe(period: string): Timeframe {
  const p = period.trim().toUpperCase();
  if (["D", "1D", "W", "M"].includes(p)) return "1d";
  if (["240", "4H"].includes(p)) return "4h";
  if (["120", "2H"].includes(p)) return "2h";
  if (["60", "1H"].includes(p)) return "1h";
  const mins = Number(p);
  return mins >= 240 ? "4h" : mins >= 120 ? "2h" : mins >= 60 ? "1h" : "1d";
}

export function nySessionDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** 用真实交易日历确定前一交易日，周末/节假日不按自然日猜测。 */
export function previousRpsSession(calendar: RpsCalendar | undefined, signalDay: string): string {
  if (!calendar || !Array.isArray(calendar.sessions) || calendar.from >= signalDay || calendar.through < signalDay) {
    throw new Error("RPS 交易日历缺失或过期，请重建快照");
  }
  const days = calendar.sessions;
  if (!days.length || days.some((day, i) => !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < calendar.from || day > calendar.through || (i > 0 && day <= days[i - 1]))) {
    throw new Error("RPS 交易日历无效");
  }
  const previous = days.filter(day => day < signalDay).at(-1);
  if (!previous) throw new Error("RPS 日历没有覆盖前一交易日");
  return previous;
}

/** 盘中只使用前一交易日日线排名，禁止把旧/未来数据用于打分和入场闸门。 */
export function freshAlertRps(snapshot: RpsSnapshot | null, symbol: string, timeframe: Timeframe, at = new Date()): (RpsEntry & RpsEvidence) | null {
  if (!snapshot) throw new Error("RPS 快照缺失或缓存已过期，先调用 ensureRpsSnapshot");
  if (snapshot.sourceTimeframe !== "1d" || snapshot.benchmark !== "SP500") throw new Error("RPS 旧版快照缺少数据来源，请重建");
  const generated = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generated) || generated > at.getTime() + 60_000) throw new Error("RPS 快照在信号之后生成，不能用于历史告警");
  const expected = previousRpsSession(snapshot.calendar, nySessionDay(at));
  const ticker = symbol.slice(symbol.lastIndexOf(":") + 1).trim().toUpperCase();
  const table = snapshot.timeframes[timeframe] ?? snapshot.timeframes["1d"];
  const entry = table?.[ticker];
  if (!entry) return null;
  if (!Number.isFinite(entry.rps) || entry.rps < 1 || entry.rps > 99) throw new Error("RPS 排名无效");
  if (entry.asOf !== expected) throw new Error(`RPS 数据过期或超前：${ticker} 截至 ${entry.asOf}，需要 ${expected}`);
  return { ...entry, generatedAt: snapshot.generatedAt, sourceTimeframe: "1d", benchmark: "SP500" };
}

export function lookupAlertRps(symbol: string, timeframe: Timeframe, at = new Date()) {
  return freshAlertRps(readRpsSnapshot(), symbol, timeframe, at);
}
