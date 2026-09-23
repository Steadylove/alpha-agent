import {
  FLIP_LABEL,
  WALL_LABEL,
  GAMMA_LABEL,
  finiteOption,
  type OptionsStructure,
} from "@/lib/options/structure";
import {
  validFrozenOptions,
  nyDay,
  type OptionSymbol,
} from "@/lib/options/signalContext";
import type { JournalSignal } from "./types";

export type StudyHorizon = "t1" | "t3" | "t5";
export type OptionsStudyRow = {
  label: string;
  total: number;
  n: number;
  days: number;
  pending: number;
  missing: number;
  mean: number | null;
  median: number | null;
  winRate: number | null;
  dayMean: number | null;
  mfe: number | null;
  mae: number | null;
  excursionN: number;
};
type Eligible = {
  signal: JournalSignal;
  structure: OptionsStructure;
  key: string;
  label: string;
};
const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function classify(
  signal: JournalSignal,
  symbol: OptionSymbol,
): Eligible | "unrecorded" | "invalid" | "metadata" | "incomplete" | "replay" {
  if (signal.source !== "live") return "replay";
  if (!signal.quality.complete) return "incomplete";
  if (!signal.optionsContext) return "unrecorded";
  if (signal.date !== nyDay(signal.signalTime)) return "invalid";
  const publication = validFrozenOptions(
    signal.optionsContext,
    signal.signalTime,
    signal.capturedAt,
  );
  const item = publication?.items.find((row) => row.symbol === symbol);
  if (
    !item?.raw ||
    [item.structure.flip, item.structure.wall, item.structure.gamma].every(
      (s) => s === "unknown",
    )
  )
    return "invalid";
  const { provenance: p, version, nearPct } = item.structure;
  if (!p.source || !p.method || !p.method_version || !item.dte)
    return "metadata";
  return {
    signal,
    structure: item.structure,
    key: JSON.stringify([
      signal.quality.version,
      version,
      p.source,
      p.method,
      p.method_version,
      item.dte,
      nearPct,
    ]),
    label: `${signal.quality.version} · ${p.source} · ${p.method} / ${p.method_version} · ${item.dte} · ±${nearPct}%`,
  };
}

function aggregate(
  label: string,
  list: Eligible[],
  horizon: StudyHorizon,
  asOf: string,
): OptionsStudyRow {
  const values: number[] = [],
    mfe: number[] = [],
    mae: number[] = [];
  const byDay = new Map<string, number[]>();
  let pending = 0,
    missing = 0;
  for (const { signal: s } of list) {
    const outcome = s.outcomes[horizon];
    if (outcome.status === "pending" || (outcome.date && outcome.date > asOf))
      pending++;
    else if (
      outcome.status === "ready" &&
      outcome.date &&
      finiteOption(outcome.value)
    ) {
      values.push(outcome.value);
      byDay.set(s.date, [...(byDay.get(s.date) ?? []), outcome.value]);
    } else missing++;
    const last = s.excursions.at(-1);
    if (
      s.outcomes.t5.date &&
      s.outcomes.t5.date <= asOf &&
      s.excursions.length === 5 &&
      s.excursions.every(
        (e) => e.date <= asOf && finiteOption(e.mfe) && finiteOption(e.mae),
      ) &&
      last?.date === s.outcomes.t5.date &&
      finiteOption(last.mfe) &&
      finiteOption(last.mae)
    ) {
      mfe.push(last.mfe);
      mae.push(last.mae);
    }
  }
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return {
    label,
    total: list.length,
    n: values.length,
    days: byDay.size,
    pending,
    missing,
    mean: mean(values),
    median: sorted.length
      ? sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2
      : null,
    winRate: values.length
      ? (values.filter((v) => v > 0).length / values.length) * 100
      : null,
    dayMean: mean([...byDay.values()].map((v) => mean(v)!)),
    mfe: mean(mfe),
    mae: mean(mae),
    excursionN: mfe.length,
  };
}

/** Caller filters quality/timeframe/score/date. This layer also enforces frozen, live, comparable inputs. */
export function optionsStudy(
  signals: JournalSignal[],
  symbol: OptionSymbol,
  horizon: StudyHorizon,
  asOf: string,
  selectedKey?: string,
) {
  const excluded = {
    unrecorded: 0,
    invalid: 0,
    metadata: 0,
    incomplete: 0,
    replay: 0,
  };
  const eligible: Eligible[] = [];
  for (const s of signals) {
    if (
      s.date > asOf ||
      !Number.isFinite(Date.parse(s.capturedAt)) ||
      nyDay(Date.parse(s.capturedAt)) > asOf
    )
      continue;
    const item = classify(s, symbol);
    if (typeof item === "string") excluded[item]++;
    else eligible.push(item);
  }
  const variants = [
    ...new Map(
      eligible.map((e) => [e.key, { key: e.key, label: e.label }]),
    ).values(),
  ];
  const key = variants.some((v) => v.key === selectedKey)
    ? selectedKey!
    : (variants[0]?.key ?? "");
  const rows = eligible.filter((e) => e.key === key);
  const group = (
    dimension: "flip" | "wall" | "gamma",
    labels: Record<string, string>,
  ) =>
    Object.entries(labels).map(([value, label]) =>
      aggregate(
        label,
        rows.filter((r) => r.structure[dimension] === value),
        horizon,
        asOf,
      ),
    );
  return {
    variants,
    key,
    excluded,
    total: rows.length,
    otherRules: eligible.length - rows.length,
    baseline: aggregate("全部已冻结结构", rows, horizon, asOf),
    groups: [
      { title: "价格与 Flip", rows: group("flip", FLIP_LABEL) },
      { title: "墙位关系", rows: group("wall", WALL_LABEL) },
      { title: "GEX 符号", rows: group("gamma", GAMMA_LABEL) },
    ],
  };
}
