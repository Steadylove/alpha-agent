import type { EntrySnapshot } from "@/lib/signals/assessment";
import type { DailyBarRow } from "@/lib/vps/loadDailyBars";
import type { JournalSignal, Outcome, ReviewTf } from "./types";
import { positive, pct, finite } from "./market";

export const reviewTf = (tf: string): ReviewTf | null =>
  ["120", "2H", "2h"].includes(tf)
    ? "2h"
    : ["240", "4H", "4h"].includes(tf)
      ? "4h"
      : null;
export const signalDay = (stamp: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(stamp);
export type EvaluationPrices = { raw: DailyBarRow[]; split: DailyBarRow[] };

/** 两套日线在同一批请求获取，用信号当日 raw/split 比率还原成入场时的股数单位。
 * 包含拆股后的价格变化，不包含现金分红；不把 all-adjusted 价格与原始告警价混算。
 */
export function evaluateEntry(
  entry: EntrySnapshot,
  sessions: string[],
  prices: EvaluationPrices | null,
  asOf: string,
): JournalSignal | null {
  const p = entry.payload,
    tf = reviewTf(p.tf);
  if (
    !tf ||
    p.event !== "buy" ||
    !positive(p.price) ||
    !positive(p.entrySignalTime) ||
    !Number.isFinite(Date.parse(entry.capturedAt))
  )
    return null;
  const date = signalDay(p.entrySignalTime),
    index = sessions.indexOf(date);
  if (date > asOf || signalDay(Date.parse(entry.capturedAt)) > asOf)
    return null;
  const raw = prices?.raw.find((b) => b.date === date)?.close,
    split = prices?.split.find((b) => b.date === date)?.close;
  const scale = positive(raw) && positive(split) ? raw / split : null;
  const rowOn = (day: string | undefined) =>
    prices?.split.find((b) => b.date === day);
  const outcome = (n: number): Outcome => {
    const day = index >= 0 ? sessions[index + n] : undefined;
    if (index < 0) return { date: null, value: null, status: "missing" };
    if (!day || day > asOf)
      return { date: day ?? null, value: null, status: "pending" };
    const close = rowOn(day)?.close;
    return scale != null && positive(close)
      ? { date: day, value: pct(close * scale, p.price), status: "ready" }
      : { date: day, value: null, status: "missing" };
  };
  const excursions: JournalSignal["excursions"] = [];
  let high = p.price,
    low = p.price,
    complete = scale != null;
  if (index >= 0)
    for (const day of sessions
      .slice(index + 1, index + 6)
      .filter((d) => d <= asOf)) {
      const bar = rowOn(day);
      if (
        !bar ||
        !positive(bar.high) ||
        !positive(bar.low) ||
        bar.high < bar.low
      )
        complete = false;
      if (bar && scale != null) {
        high = Math.max(high, bar.high * scale);
        low = Math.min(low, bar.low * scale);
      }
      excursions.push({
        date: day,
        mfe: complete ? pct(high, p.price) : null,
        mae: complete ? pct(low, p.price) : null,
      });
    }
  const lag = Date.parse(entry.capturedAt) - p.entrySignalTime;
  const source =
    entry.candidate?.replay || lag < -60_000 || lag > 15 * 60_000
      ? "replay"
      : "live";
  return {
    id: entry.id,
    symbol: p.symbol.slice(p.symbol.lastIndexOf(":") + 1).toUpperCase(),
    tf,
    date,
    signalTime: p.entrySignalTime,
    capturedAt: entry.capturedAt,
    price: p.price,
    quality: entry.quality,
    sector:
      entry.quality.version === "quality-v5"
        ? (entry.candidate?.sector.row?.name ?? null)
        : null,
    context: entry.marketContext ?? null,
    ...(entry.optionsContext ? { optionsContext: structuredClone(entry.optionsContext) } : {}),
    source,
    outcomes: { t1: outcome(1), t3: outcome(3), t5: outcome(5) },
    excursions,
  };
}

/** 历史页面只能看到当日已收到的信号及当时已成熟的结果。 */
export function journalAsOf(
  signals: JournalSignal[],
  date: string,
): JournalSignal[] {
  return signals
    .filter(
      (s) => s.date <= date && signalDay(Date.parse(s.capturedAt)) <= date,
    )
    .map((s) => ({
      ...s,
      outcomes: Object.fromEntries(
        Object.entries(s.outcomes).map(([k, v]) => [
          k,
          v.date && v.date > date
            ? { ...v, value: null, status: "pending" }
            : v,
        ]),
      ) as JournalSignal["outcomes"],
      excursions: s.excursions.filter((e) => e.date <= date),
    }));
}

/** 后续任务只补成熟结果。暂时断源不能抹掉已验证结果，也不能改写首次公开的评分。 */
export function mergeEvaluation(
  previous: JournalSignal | undefined,
  incoming: JournalSignal,
): JournalSignal {
  if (!previous) return incoming;
  const excursions = new Map(previous.excursions.map((e) => [e.date, e]));
  for (const e of incoming.excursions)
    if (excursions.get(e.date)?.mfe == null) excursions.set(e.date, e);
  return {
    ...previous,
    outcomes: {
      t1:
        previous.outcomes.t1.status === "ready"
          ? previous.outcomes.t1
          : incoming.outcomes.t1,
      t3:
        previous.outcomes.t3.status === "ready"
          ? previous.outcomes.t3
          : incoming.outcomes.t3,
      t5:
        previous.outcomes.t5.status === "ready"
          ? previous.outcomes.t5
          : incoming.outcomes.t5,
    },
    excursions: [...excursions.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
  };
}

export type Cohort = {
  label: string;
  n: number;
  pending: number;
  missing: number;
  mean: number | null;
  winRate: number | null;
};
export function cohort(label: string, rows: JournalSignal[]): Cohort {
  const matured = rows.map((s) => s.outcomes.t5.value).filter(finite);
  return {
    label,
    n: matured.length,
    pending: rows.filter((s) => s.outcomes.t5.status === "pending").length,
    missing: rows.filter((s) => s.outcomes.t5.status === "missing").length,
    mean: matured.length
      ? matured.reduce((a, b) => a + b, 0) / matured.length
      : null,
    winRate: matured.length
      ? (matured.filter((v) => v > 0).length / matured.length) * 100
      : null,
  };
}
export function correlation(
  rows: JournalSignal[],
  factor: string,
): { n: number; r: number | null } {
  const pairs = rows
    .map((s) => {
      const x = s.quality.dimensions.find((d) => d.name === factor),
        y = s.outcomes.t5.value;
      return x && finite(x.points) && x.max > 0 && finite(y)
        ? [x.points / x.max, y]
        : null;
    })
    .filter((p): p is number[] => p != null);
  const n = pairs.length;
  if (n < 20) return { n, r: null };
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n,
    my = pairs.reduce((a, p) => a + p[1], 0) / n;
  const cov = pairs.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  const xx = pairs.reduce((a, p) => a + (p[0] - mx) ** 2, 0),
    yy = pairs.reduce((a, p) => a + (p[1] - my) ** 2, 0);
  return { n, r: xx > 0 && yy > 0 ? cov / Math.sqrt(xx * yy) : null };
}
