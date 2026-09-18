import { existsSync, readFileSync } from "node:fs";
import { alphaScore } from "./engine";
import { csvDir, rpsScaleFile, rpsSnapshotFile } from "./marketStore";
import { readCsvPanels } from "./csvPanel";
import { quantileCuts, scalePercentile, type RpsScaleFile } from "./rpsScale";
import { tickersForPool } from "./smallFundPools";
import { lastSettledNyDate } from "./mergeBars";
import { nySessionDay, type RpsCalendar, type RpsSnapshot } from "./rpsSnapshot";
import type { PanelBars } from "./panel";
import { alpacaCredentials } from "@/lib/data-sources/alpaca";
import { fetchSp500Universe } from "@/lib/data-sources/sp500";
import { writeJsonAtomic } from "@/lib/files/atomicJson";

/** 信号排名只需已收盘日的动量分，不必准备整池盘中交易指标。 */
export function signalRpsFromPanels(panels: readonly PanelBars[], benchmark: readonly string[], day: string, calendar: RpsCalendar, now = new Date()) {
  const scores = new Map<string, number>();
  for (const panel of panels) {
    const i = panel.dates.indexOf(day);
    if (i < 0) continue; // 停牌/漏更的股票不沿用旧价格假装当日排名。
    const score = alphaScore(panel.close, i);
    if (Number.isFinite(score)) scores.set(panel.ticker, score);
  }
  const members = [...new Set(benchmark)];
  const ranked = members.flatMap(ticker => scores.has(ticker) ? [scores.get(ticker)!] : []).sort((a, b) => a - b);
  if (members.length < 450 || ranked.length / members.length < .98) throw new Error(`RPS 标普样本不足：${ranked.length}/${members.length}，停止发布`);
  const cuts = quantileCuts(ranked).map(value => Math.round(value * 100) / 100);
  const scale = Float64Array.from(cuts);
  const table = Object.fromEntries([...scores].map(([ticker, score]) => [ticker, { rps: Number(scalePercentile(scale, score).toFixed(2)), asOf: day }]));
  const snapshot: RpsSnapshot = { generatedAt: now.toISOString(), poolId: "sf-broad", sourceTimeframe: "1d", benchmark: "SP500", calendar,
    // 所有盘中告警都用前一交易日的日线 RPS，不能取上一根盘中值再额外滞后一天。
    timeframes: { "1d": table, "4h": table, "2h": table, "1h": table } };
  return { snapshot, cuts, count: ranked.length };
}

export async function fetchRpsCalendar(now = new Date()): Promise<RpsCalendar> {
  const { key, secret } = alpacaCredentials();
  const from = nySessionDay(new Date(now.getTime() - 45 * 86400000));
  const through = nySessionDay(new Date(now.getTime() + 45 * 86400000));
  const base = key.startsWith("PK") ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
  const response = await fetch(`${base}/v2/calendar?start=${from}&end=${through}`, {
    headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`RPS 交易日历 HTTP ${response.status}`);
  const rows = await response.json() as { date: string }[];
  if (!Array.isArray(rows) || rows.length < 30 || rows.some(row => !/^\d{4}-\d{2}-\d{2}$/.test(row.date))) throw new Error("RPS 交易日历返回无效");
  return { from, through, sessions: [...new Set(rows.map(row => row.date))].sort() };
}

/** Alpaca 请求终点保留 20 分钟延迟；收盘后也要等到该终点包含完整日线。 */
export function latestRpsSession(calendar: RpsCalendar, now = new Date()) {
  const available = lastSettledNyDate(new Date(now.getTime() - 20 * 60_000));
  const day = calendar.sessions.filter(date => date <= available).at(-1);
  if (!day) throw new Error("日历没有最近已收盘交易日");
  return day;
}

/** 新行情算新切点；不再把上次分布复制到新日期，也不改写历史信号记录。 */
export async function buildAndStoreSignalRps(now = new Date()) {
  const [calendar, constituents] = await Promise.all([fetchRpsCalendar(now), fetchSp500Universe()]);
  const day = latestRpsSession(calendar, now);
  const benchmark = constituents.map(row => row.symbol);
  const wanted = [...new Set([...tickersForPool("sf-broad"), ...benchmark])];
  const panels = readCsvPanels(csvDir("1d"), wanted);
  const result = signalRpsFromPanels(panels, benchmark, day, calendar, now);
  const file = rpsScaleFile();
  if (existsSync(file)) {
    const old = JSON.parse(readFileSync(file, "utf8")) as RpsScaleFile;
    const index = old.dates.indexOf(day);
    if (index >= 0) { old.cuts[index] = result.cuts; old.counts[index] = result.count; }
    else {
      if (old.dates.at(-1)! > day) throw new Error("标尺包含未来日期，停止发布");
      old.dates.push(day); old.cuts.push(result.cuts); old.counts.push(result.count);
    }
    old.generatedAt = now.toISOString();
    writeJsonAtomic(file, old);
  }
  writeJsonAtomic(rpsSnapshotFile(), result.snapshot);
  console.log(`[rps] 已更新 ${day}，标普样本 ${result.count}/${benchmark.length}，信号标的 ${Object.keys(result.snapshot.timeframes['1d']!).length}`);
  return result.snapshot;
}
