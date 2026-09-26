import { alphaScore } from "@/lib/backtest/engine";
import { scalePercentile, type RpsScaleFile } from "@/lib/backtest/rpsScale";
import type { PanelBars } from "@/lib/backtest/panel";
import type { CatalystEvent, CatalystUniverse, EventReaction, Observation } from "./types";
import { etDay, validDay } from "./normalize";

export type ReactionInputs = {
  sessions: string[];
  /** Last completed daily-data session, not the wall-clock date. */
  asOf: string;
  panels: Map<string, PanelBars>;
  scale: RpsScaleFile | null;
  universe: CatalystUniverse;
  /** Exchange calendar close, in America/New_York HH:mm (including early closes). */
  sessionCloses?: Record<string, string>;
};
const pos = (n: number | undefined): n is number => n != null && Number.isFinite(n) && n > 0;
const round = (n: number) => Math.round(n * 100) / 100;
const validStamp = (stamp: string | null | undefined): stamp is string => typeof stamp === "string" && Number.isFinite(Date.parse(stamp));
const validAxis = (days: string[]) => days.length > 0 && days.every((day, i) => validDay(day) && (i === 0 || day > days[i - 1]));
const valueAt = (panel: PanelBars | undefined, day: string, field: "close" | "high" | "low" = "close") => {
  const i = panel?.dates.indexOf(day) ?? -1;
  const value = i >= 0 ? panel?.[field][i] : undefined;
  return pos(value) ? value : null;
};
function closeMinute(day: string, closes?: Record<string, string>): number | null {
  const close = closes?.[day];
  if (close === undefined) return 16 * 60;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(close)) return null;
  return Number(close.slice(0, 2)) * 60 + Number(close.slice(3, 5));
}
function etMinute(stamp: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(new Date(stamp));
  return Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
}

/** The anchor is a calendar session, never the next available price row. */
export function eventAnchor(event: CatalystEvent, sessions: string[], sessionCloses?: Record<string, string>): string | null {
  if (event.status !== "published" || !validStamp(event.publishedAt) || event.timePrecision !== "minute" || !validAxis(sessions)) return null;
  const day = etDay(event.publishedAt);
  // A truncated calendar cannot identify the first session after an old announcement.
  if (day < sessions[0] || day > sessions.at(-1)!) return null;
  const close = closeMinute(day, sessionCloses);
  if (close == null) return null;
  return sessions.find((date) => date > day || date === day && etMinute(event.publishedAt!) < close) ?? null;
}

function rpsAt(input: ReactionInputs, ticker: string, date: string): number | null {
  const scale = input.scale, panel = input.panels.get(ticker);
  if (!panel || !scale || scale.index !== "SP500" || scale.buckets !== 99 || !Array.isArray(scale.dates) || !validAxis(scale.dates) ||
      !Array.isArray(scale.counts) || !Array.isArray(scale.cuts) || scale.dates.length !== scale.counts.length || scale.dates.length !== scale.cuts.length ||
      !validStamp(scale.generatedAt) || !validStamp(input.universe.observedAt) || Date.parse(scale.generatedAt) > Date.parse(input.universe.observedAt)) return null;
  const si = scale.dates.indexOf(date), pi = panel.dates.indexOf(date), count = scale.counts[si], cuts = scale.cuts[si];
  if (pi < 252 || si < 0 || !Number.isInteger(count) || count < 450 || !Array.isArray(cuts) || cuts.length !== 99 ||
      !cuts.every((value, i) => Number.isFinite(value) && (i === 0 || value >= cuts[i - 1]))) return null;
  // Match the existing composite formula. Do not replace it with an Opportunity horizon RPS.
  if (![0, 21, 63, 126, 252].every((lookback) => pos(panel.close[pi - lookback]))) return null;
  const score = alphaScore(panel.close, pi);
  return Number.isFinite(score) ? round(scalePercentile(Float64Array.from(cuts), score)) : null;
}
function sectorAt(input: ReactionInputs, etf: string | null, day: string): number | null {
  const index = input.sessions.indexOf(day), old = input.sessions[index - 20];
  if (!etf || index < 20 || !old) return null;
  const a = valueAt(input.panels.get(etf), day), b = valueAt(input.panels.get(etf), old);
  const c = valueAt(input.panels.get("SPY"), day), d = valueAt(input.panels.get("SPY"), old);
  return a != null && b != null && c != null && d != null ? round(100 * (a / b - c / d)) : null;
}

export function calculateReaction(event: CatalystEvent, symbol: string, input: ReactionInputs): EventReaction {
  const observed = validStamp(input.universe.observedAt) ? Date.parse(input.universe.observedAt) : NaN;
  const publicationKnown = validStamp(event.publishedAt) && Date.parse(event.publishedAt) <= observed;
  const anchorDate = publicationKnown && validDay(input.asOf) ? eventAnchor(event, input.sessions, input.sessionCloses) : null;
  const index = anchorDate ? input.sessions.indexOf(anchorDate) : -1;
  const before = index > 0 ? input.sessions[index - 1] : null;
  const panel = input.panels.get(symbol), close = before ? valueAt(panel, before) : null;
  const baseline = before && close != null && before <= input.asOf ? { date: before, close } : null;
  const measure = (date: string | null, value: () => number | null, absent: "pending" | "missing" = "pending"): Observation => {
    if (!anchorDate) return { date, value: null, status: "unavailable" };
    if (!date) return { date, value: null, status: absent };
    if (date > input.asOf) return { date, value: null, status: "pending" };
    const v = value();
    return { date, value: v, status: v == null ? "missing" : "ready" };
  };
  const outcome = (n: number) => {
    const date = index >= 0 ? input.sessions[index + n] ?? null : null;
    return measure(date, () => {
      const value = date ? valueAt(panel, date) : null;
      return value != null && baseline ? round((value / baseline.close - 1) * 100) : null;
    });
  };
  const latest = index >= 0 ? input.sessions.slice(index, index + 6).filter((day) => day <= input.asOf).at(-1) ?? null : null;
  const sectorId = input.universe.symbols.find((row) => row.symbol === symbol)?.sectorId;
  const etf = input.universe.sectors.find((row) => row.id === sectorId)?.etf ?? (input.universe.sectors.some((row) => row.etf === symbol) ? symbol : null);
  const afterDays = index >= 0 ? input.sessions.slice(index + 1, index + 6) : [];
  const matureDays = afterDays.filter((day) => day <= input.asOf);
  const excursion = (field: "high" | "low") => measure(matureDays.at(-1) ?? afterDays[0] ?? null, () => {
    if (!baseline || !matureDays.length) return null;
    const values = matureDays.map((day) => {
      const high = valueAt(panel, day, "high"), low = valueAt(panel, day, "low");
      return high != null && low != null && high >= low ? field === "high" ? high : low : null;
    });
    if (values.some((value) => value == null)) return null;
    const extreme = field === "high" ? Math.max(baseline.close, ...values as number[]) : Math.min(baseline.close, ...values as number[]);
    return round((extreme / baseline.close - 1) * 100);
  });
  const end = index >= 0 ? input.sessions[index + 5] ?? null : null;
  const signalsAfter = anchorDate && validStamp(event.publishedAt) ? input.universe.signals.filter((signal) => {
    if (signal.symbol !== symbol || !validStamp(signal.signalTime) || !validStamp(signal.capturedAt)) return false;
    const at = Date.parse(signal.signalTime), captured = Date.parse(signal.capturedAt);
    if (at < Date.parse(event.publishedAt!) || at > observed || captured > observed || captured < at - 60_000 || captured > at + 15 * 60_000) return false;
    const day = etDay(signal.signalTime);
    if (day > input.asOf || etDay(signal.capturedAt) > input.asOf || !input.sessions.includes(day)) return false;
    if (end && (day > end || day === end && etMinute(signal.signalTime) > (closeMinute(end, input.sessionCloses) ?? -1))) return false;
    return true;
  }) : [];
  return { eventId: event.id, symbol, asOf: input.asOf, anchorDate, baseline,
    basis: "现有日线CSV窗口；Alpaca更新默认all调整（含拆股和分红），并非仅拆股；历史增量文件不保证逐根同源。以前一常规收盘为基准，含盘中公告前波动，不代表即时反应或因果。T0为发布后首个常规收盘，T+1/3/5按交易日；MFE/MAE仅取T+1至已成熟T+5。" +
      (input.sessionCloses ? "收市边界使用交易日历；未提供的日期按美东16:00。" : "未提供每日收市时间，边界按美东16:00；早收市日可能需重新核对。"),
    price: { t0: outcome(0), t1: outcome(1), t3: outcome(3), t5: outcome(5) },
    rps: { metric: "composite-daily-sp500-v1", before: measure(before, () => before ? rpsAt(input, symbol, before) : null, "missing"), after: measure(latest, () => latest ? rpsAt(input, symbol, latest) : null) },
    sector: { metric: "sector-etf-20d-excess-spy-v1", etf, before: measure(before, () => before ? sectorAt(input, etf, before) : null, "missing"), after: measure(latest, () => latest ? sectorAt(input, etf, latest) : null) },
    mfe: excursion("high"), mae: excursion("low"), signalsAfter };
}
