import { alphaScore } from "@/lib/backtest/engine";
import { scalePercentile, type RpsScaleFile } from "@/lib/backtest/rpsScale";
import type { PanelBars } from "@/lib/backtest/panel";
import type { RpsSnapshot } from "@/lib/backtest/rpsSnapshot";
import type { OptionFlowStore } from "../types";
import { normalizeFlowEvents, type FlowEvent } from "./events";
import { flowTheme, THEME_VERSION } from "./themes";

export type ResearchInputs = { flow: OptionFlowStore; scale: RpsScaleFile | null; rps: RpsSnapshot | null;
  panels: Map<string, PanelBars>; sessions: string[]; warnings: string[] };
export type Strength = "强势改善" | "强势持平" | "强势回落" | "强度改善" | "强度偏弱" | "待确认" | "ETF / 指数";
export type FlowProfile = ReturnType<typeof flowTheme> & {
  ticker: string; count: number; premium: number; bull: number; bear: number; unknown: number;
  direction: "偏多" | "偏空" | "混合" | "未分类";
  rps: number | null; priorRps: number | null; rpsDate: string; delta1: number | null; delta5: number | null; delta20: number | null;
  change: number | null; strength: Strength; persistence: "首次观察" | "再次出现" | "持续出现";
  days5: number; days20: number; consecutive: number;
};
export type FlowResearch = {
  version: 1; ruleVersion: string; date: string; builtAt: string; sourceUpdatedAt: string;
  origin: "archived" | "reconstructed"; events: FlowEvent[]; profiles: FlowProfile[];
  totals: { records: number; tickers: number; premium: number; bull: number; bear: number; unknown: number; priced: number; top3: number | null; repeat: number; excluded: number };
  themes: { name: string; premium: number; count: number; tickers: string[] }[];
  coverage: { observed5: number; expected5: number; rps: number; stocks: number };
  read: string; warnings: string[];
};
export type FlowOutcome = { date: string; ticker: string; strength: Strength; persistence: FlowProfile["persistence"];
  rps: number | null; entryDate: string | null; entry: number | null;
  t1: number | null; t5: number | null; t10: number | null; excess5: number | null; mfe: number | null; mae: number | null; status: string };
const round = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number | undefined, b: number | undefined) => a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && b > 0 ? round((a / b - 1) * 100) : null;

export function researchRps(inputs: ResearchInputs, ticker: string, day?: string): number | null {
  if (!day) return null;
  const snapshot = inputs.rps;
  const entry = snapshot?.sourceTimeframe === "1d" && snapshot.benchmark === "SP500" ? snapshot.timeframes["1d"]?.[ticker] : null;
  if (entry?.asOf === day && Number.isFinite(entry.rps) && entry.rps >= 1 && entry.rps <= 99) return entry.rps;
  const i = inputs.scale?.dates.indexOf(day) ?? -1;
  const cuts = inputs.scale?.cuts[i];
  const panel = inputs.panels.get(ticker);
  const bar = panel?.dates.indexOf(day) ?? -1;
  if (!panel || bar < 0 || !cuts?.length || (inputs.scale?.counts[i] ?? 0) < 450 || cuts.some(n => !Number.isFinite(n))) return null;
  const score = alphaScore(panel.close, bar);
  return Number.isFinite(score) ? round(scalePercentile(Float64Array.from(cuts), score)) : null;
}

export function buildFlowResearch(inputs: ResearchInputs, day: string, now = new Date()): FlowResearch {
  if (!inputs.sessions.includes(day)) throw new Error("日期不在交易日历内");
  const { events: all, observed, excluded } = normalizeFlowEvents(inputs.flow.posts, inputs.sessions);
  const events = all.filter(e => e.day === day);
  const sessions = inputs.sessions.filter(d => d <= day);
  const previous = sessions.at(-2);
  const window5 = sessions.slice(-5), window20 = sessions.slice(-20);
  const profiles: FlowProfile[] = [...new Set(events.map(e => e.ticker))].map((ticker): FlowProfile => {
    const legs = events.filter(e => e.ticker === ticker);
    const info = flowTheme(ticker, inputs.rps?.sector);
    const rps = info.asset === "个股" ? researchRps(inputs, ticker, day) : null;
    const priorRps = info.asset === "个股" ? researchRps(inputs, ticker, previous) : null;
    const delta = (n: number) => { const old = info.asset === "个股" ? researchRps(inputs, ticker, sessions.at(-n - 1)) : null; return rps != null && old != null ? round(rps - old) : null; };
    const delta5 = delta(5);
    const appeared = new Set(all.filter(e => e.ticker === ticker && e.day <= day).map(e => e.day));
    const days5 = window5.filter(d => appeared.has(d)).length;
    const days20 = window20.filter(d => appeared.has(d)).length;
    let consecutive = 0;
    for (const d of [...sessions].reverse()) { if (!appeared.has(d)) break; consecutive++; }
    const bull = legs.filter(e => e.direction === "bull").reduce((s, e) => s + (e.premium ?? 0), 0);
    const bear = legs.filter(e => e.direction === "bear").reduce((s, e) => s + (e.premium ?? 0), 0);
    const unknown = legs.filter(e => e.direction === "unknown").reduce((s, e) => s + (e.premium ?? 0), 0);
    const panel = inputs.panels.get(ticker), i = panel?.dates.indexOf(day) ?? -1, p = panel?.dates.indexOf(previous ?? "") ?? -1;
    return { ticker, ...info, count: legs.length, premium: bull + bear + unknown, bull, bear, unknown,
      direction: bull + bear === 0 ? "未分类" : unknown > 0 || bull > 0 && bear > 0 ? "混合" : bull > 0 ? "偏多" : "偏空",
      rps, priorRps, rpsDate: day, delta1: delta(1), delta5, delta20: delta(20),
      change: panel && i >= 0 && p >= 0 ? pct(panel.close[i], panel.close[p]) : null,
      strength: info.asset !== "个股" ? "ETF / 指数" : rps == null || delta5 == null ? "待确认" : rps >= 80 ? delta5 > 0 ? "强势改善" : delta5 === 0 ? "强势持平" : "强势回落" : delta5 > 0 ? "强度改善" : "强度偏弱",
      persistence: days5 >= 3 ? "持续出现" : days20 >= 2 ? "再次出现" : "首次观察", days5, days20, consecutive,
    };
  }).sort((a, b) => b.premium - a.premium || a.ticker.localeCompare(b.ticker));
  const sum = (key: "premium" | "bull" | "bear" | "unknown") => profiles.reduce((s, p) => s + p[key], 0);
  const premium = sum("premium");
  const themes = [...new Set(profiles.map(p => p.theme))].map(name => {
    const rows = profiles.filter(p => p.theme === name);
    return { name, premium: rows.reduce((s, p) => s + p.premium, 0), count: rows.reduce((s, p) => s + p.count, 0), tickers: rows.map(p => p.ticker) };
  }).sort((a, b) => b.premium - a.premium || a.name.localeCompare(b.name));
  const top3 = premium > 0 ? round(profiles.slice(0, 3).reduce((s, p) => s + p.premium, 0) / premium * 100) : null;
  const repeat = profiles.filter(p => p.persistence !== "首次观察").length;
  const observed5 = window5.filter(d => observed.includes(d)).length;
  const stocks = profiles.filter(p => p.asset === "个股");
  const rpsCovered = stocks.filter(p => p.rps != null).length;
  const warnings = [...inputs.warnings];
  if (observed5 < window5.length) warnings.push(`近 5 个交易日只有 ${observed5}/${window5.length} 日发现来源消息；没有消息的日期无法确认采集完整，重复次数仅为已观察值。`);
  if (rpsCovered < stocks.length) warnings.push(`${stocks.length - rpsCovered} 个股票缺少该日 RPS；不使用旧排名代替。`);
  if (events.some(e => e.premium == null)) warnings.push("金额不明或多腿金额归属不明的记录保留展示，不计入金额和集中度。");
  const read = events.length ? `今日收录 ${events.length} 条异常流记录，涉及 ${profiles.length} 个标的。${premium > 0 ? `已知权利金主要集中于${themes[0]?.name}，前三标的占 ${top3}%。` : "暂无可归属的权利金金额。"}${repeat} 个标的在近 20 个交易日再次出现；${profiles.filter(p => p.strength === "强势改善").length} 个标的同时呈现高 RPS 与强度改善。` : "该日没有符合研究口径的独立记录；这不代表全市场没有异常成交。";
  return { version: 1, ruleVersion: `flow-v1/${THEME_VERSION}`, date: day, builtAt: now.toISOString(), sourceUpdatedAt: inputs.flow.updatedAt,
    origin: "reconstructed", events, profiles, themes, totals: { records: events.length, tickers: profiles.length, premium,
      bull: sum("bull"), bear: sum("bear"), unknown: sum("unknown"), priced: events.filter(e => e.premium != null).length, top3, repeat, excluded: excluded[day] ?? 0 },
    coverage: { observed5, expected5: window5.length, rps: rpsCovered, stocks: stocks.length }, read, warnings };
}

/** Next-session OPEN reference; exact exchange sessions, no missing-day compression. Stock price returns, not option P&L. */
export function flowOutcomes(reports: readonly FlowResearch[], inputs: ResearchInputs, asOf: string): FlowOutcome[] {
  const spy = inputs.panels.get("SPY");
  const rows: FlowOutcome[] = [];
  for (const report of reports.filter(r => r.date < asOf)) for (const stock of report.profiles.filter(p => p.asset === "个股")) {
    const panel = inputs.panels.get(stock.ticker);
    const base = inputs.sessions.indexOf(report.date);
    const future = inputs.sessions.slice(base + 1, base + 11);
    const entryDate = future[0] ?? null;
    const ei = panel?.dates.indexOf(entryDate ?? "") ?? -1;
    const entry = entryDate && entryDate <= asOf && ei >= 0 && panel?.open && panel.open[ei] > 0 ? panel.open[ei] : null;
    const target = (n: number) => {
      const day = future[n - 1];
      if (!entry || !day || day > asOf || !panel || future.slice(0, n).some(d => !panel.dates.includes(d))) return null;
      return pct(panel.close[panel.dates.indexOf(day)], entry);
    };
    const t5 = target(5), target5 = future[4];
    const spyEntry = spy?.open?.[spy.dates.indexOf(entryDate ?? "")];
    const spyReturn = target5 && target5 <= asOf && spy ? pct(spy.close[spy.dates.indexOf(target5)], spyEntry) : null;
    const mature = future.length === 10 && future[9] <= asOf && panel && future.every(d => panel.dates.includes(d));
    const highs = mature ? future.map(d => panel.high[panel.dates.indexOf(d)]) : [];
    const lows = mature ? future.map(d => panel.low[panel.dates.indexOf(d)]) : [];
    rows.push({ date: report.date, ticker: stock.ticker, strength: stock.strength, persistence: stock.persistence, rps: stock.rps,
      entryDate, entry, t1: target(1), t5, t10: target(10), excess5: t5 != null && spyReturn != null ? round(t5 - spyReturn) : null,
      mfe: mature && entry ? Math.max(0, pct(Math.max(...highs), entry)!) : null,
      mae: mature && entry ? Math.min(0, pct(Math.min(...lows), entry)!) : null,
      status: !panel ? "缺行情" : !entry ? "等待次日开盘 / 缺开盘价" : target(10) != null ? "10日观察完成" : "观察中 / 尚缺完整行情" });
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || a.ticker.localeCompare(b.ticker));
}
