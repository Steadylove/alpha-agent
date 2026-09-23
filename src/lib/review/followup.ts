import type { RpsSnapshot } from "@/lib/backtest/rpsSnapshot";
import type { DailyReview, JournalSignal, ReviewTf } from "./types";

export const FOLLOWUP_VERSION = "signal-followup-v1" as const;
export type SignalExit = { id: string; eventTime: number; capturedAt: string };
export type FollowupRow = {
  id: string;
  symbol: string;
  tf: ReviewTf;
  signalId: string | null;
  signalDate: string | null;
  signal: "new" | "exit-recorded" | "awaiting-review" | "none";
  position: "held" | "not-held" | "unknown";
  rps: number | null;
  priorRps: number | null;
  strength: "strong" | "stable" | "weakening" | "recovering" | "unknown";
  sector: { name: string; percentile: number; relative20: number } | null;
  initialScore: number | null;
  scoreVersion: string | null;
};
export type FollowupSnapshot = {
  version: typeof FOLLOWUP_VERSION;
  date: string;
  observedAt: string;
  basis: "daily" | "reconstructed";
  rows: FollowupRow[];
  warnings: string[];
};
export const SIGNAL_LABELS = {
  new: "新触发",
  "exit-recorded": "已收到退出记录",
  "awaiting-review": "待复核",
  none: "模型持仓",
};
export const STRENGTH_LABELS = {
  strong: "RPS 强势",
  stable: "未达 RPS 强势区",
  weakening: "RPS 走弱",
  recovering: "RPS 回升",
  unknown: "RPS 待更新",
};
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
const nyDay = (time: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
    time,
  );

/** Daily observations never overwrite entry quality. No exit message does not imply an active signal. */
export function buildFollowup(input: {
  review: DailyReview;
  signals: JournalSignal[];
  rps: RpsSnapshot | null;
  exits: SignalExit[];
  previous?: FollowupSnapshot;
  existing?: FollowupSnapshot;
  sessions: string[];
  basis: FollowupSnapshot["basis"];
  exitReadFailed?: boolean;
}): FollowupSnapshot {
  const { review: r, rps, exits } = input;
  const warnings: string[] = [];
  const generated = Date.parse(rps?.generatedAt ?? "");
  const validRps =
    rps?.sourceTimeframe === "1d" &&
    rps.benchmark === "SP500" &&
    Number.isFinite(generated) &&
    generated <= Date.parse(r.builtAt);
  if (!validRps) warnings.push("RPS 来源或生成时间未通过校验");
  if (input.exitReadFailed)
    warnings.push("部分退出留档读取失败，未推断信号仍然有效");
  const prior =
    input.previous?.version === FOLLOWUP_VERSION &&
    input.previous.date === r.previousDate
      ? input.previous
      : undefined;
  const existing =
    input.existing?.version === FOLLOWUP_VERSION &&
    input.existing.date === r.date &&
    Date.parse(input.existing.observedAt) <= Date.parse(r.builtAt)
      ? input.existing
      : undefined;
  let reused = false;
  const cutoff =
    input.sessions.filter((d) => d <= r.date).slice(-20)[0] ?? r.date;
  const held = (symbol: string, tf: ReviewTf): FollowupRow["position"] => {
    const a = r.accounts.find((a) => a.tf === tf);
    if (!a || a.asOf?.slice(0, 10) !== r.date || a.holdings == null)
      return "unknown";
    return a.positions.some((p) => p.symbol === symbol) ? "held" : "not-held";
  };
  const candidates = input.signals.filter(
    (s) =>
      s.source === "live" &&
      s.date <= r.date &&
      Date.parse(s.capturedAt) <= Date.parse(r.builtAt) &&
      (s.date >= cutoff || held(s.symbol, s.tf) === "held"),
  );
  const identities: {
    id: string;
    symbol: string;
    tf: ReviewTf;
    entry?: JournalSignal;
  }[] = candidates.map((s) => ({
    id: s.id,
    symbol: s.symbol,
    tf: s.tf,
    entry: s,
  }));
  for (const a of r.accounts) {
    if (a.asOf?.slice(0, 10) !== r.date || a.holdings == null) continue;
    for (const p of a.positions)
      if (!identities.some((s) => s.symbol === p.symbol && s.tf === a.tf))
        identities.push({
          id: `position:${a.tf}:${p.symbol}`,
          symbol: p.symbol,
          tf: a.tf,
        });
  }
  const rows = identities
    .map(({ id, symbol, tf, entry }): FollowupRow => {
      const x = validRps ? rps?.timeframes[tf]?.[symbol] : null;
      const saved = existing?.rows.find((s) => s.id === id);
      const incomingRps =
        x?.asOf === r.date && finite(x.rps) && x.rps >= 1 && x.rps <= 99
          ? x.rps
          : null;
      const value = incomingRps ?? saved?.rps ?? null;
      if (incomingRps == null && saved?.rps != null) reused = true;
      const before = prior?.rows.find((s) => s.id === id);
      const delta =
        value != null && before?.rps != null ? value - before.rps : null;
      let strength: FollowupRow["strength"] =
        value == null ? "unknown" : value >= 80 ? "strong" : "stable";
      if (delta != null && delta <= -10) strength = "weakening";
      else if (
        delta != null &&
        delta >= 5 &&
        (before?.strength === "weakening" || before?.strength === "recovering")
      )
        strength = "recovering";
      const sectorSnapshot =
        validRps &&
        rps?.sector?.asOf === r.date &&
        rps.sector.membershipAsOf <= r.date &&
        Date.parse(rps.sector.generatedAt) <= Date.parse(r.builtAt)
          ? rps.sector
          : null;
      const sectorRow = sectorSnapshot?.sectors.find(
        (s) => s.id === sectorSnapshot.classification[symbol],
      );
      const sector =
        sectorRow &&
        finite(sectorRow.percentile) &&
        finite(sectorRow.relative20)
          ? {
              name: sectorRow.name,
              percentile: sectorRow.percentile,
              relative20: sectorRow.relative20,
            }
          : (saved?.sector ?? null);
      if (!sectorRow && saved?.sector) reused = true;
      const exited =
        entry &&
        (saved?.signal === "exit-recorded" ||
          exits.some(
            (e) =>
              e.id === id &&
              e.eventTime >= entry.signalTime &&
              nyDay(e.eventTime) <= r.date &&
              e.eventTime <= Date.parse(e.capturedAt) &&
              Date.parse(e.capturedAt) <= Date.parse(r.builtAt),
          ));
      return {
        id,
        symbol,
        tf,
        signalId: entry?.id ?? null,
        signalDate: entry?.date ?? null,
        signal: !entry
          ? "none"
          : exited
            ? "exit-recorded"
            : entry.date === r.date
              ? "new"
              : "awaiting-review",
        position: held(symbol, tf),
        rps: value,
        priorRps: before?.rps ?? null,
        strength,
        sector,
        initialScore: entry?.quality.complete ? entry.quality.points : null,
        scoreVersion: entry?.quality.version ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (rows.some((r) => r.rps == null))
    warnings.push("部分个股缺少对应交易日 RPS，未使用当前排名补写历史");
  if (reused)
    warnings.push("部分输入暂缺，沿用同一交易日已归档的 RPS / 板块观测");
  return {
    version: FOLLOWUP_VERSION,
    date: r.date,
    observedAt: r.builtAt,
    basis: input.basis,
    rows,
    warnings,
  };
}
