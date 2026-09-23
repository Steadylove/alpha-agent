import {
  optionsStructure,
  OPTIONS_STRUCTURE_VERSION,
  type GexSnapshotItem,
  type OptionsStructure,
} from "./structure";
import type { OptionsRow } from "@/lib/review/types";

export const OPTION_SYMBOLS = ["SPX", "SPY", "QQQ", "IWM"] as const;
export type OptionSymbol = (typeof OPTION_SYMBOLS)[number];
export type OptionsPublication = {
  version: "options-publication-v1";
  id: string;
  reviewDate: string;
  validForSession: string;
  publishedAt: string;
  items: {
    symbol: OptionSymbol;
    dte: string | null;
    raw: GexSnapshotItem | null;
    structure: OptionsStructure;
  }[];
};
export type OptionsUnavailableReason =
  | "not-published"
  | "unavailable"
  | "invalid"
  | "future"
  | "stale"
  | "delayed-signal";
export type SignalOptionsContext = {
  version: "signal-options-v1";
  mode: "previous-session";
  signalTime: number;
  frozenAt: string;
  status: "available" | "partial" | "missing";
  reason?: OptionsUnavailableReason;
  publication: OptionsPublication | null;
};
export const OPTIONS_MISSING_LABEL: Record<OptionsUnavailableReason, string> = {
  "not-published": "尚无已发布的期权上下文",
  unavailable: "期权上下文读取失败",
  invalid: "快照或发布时间校验未通过",
  future: "快照在信号之后才可用",
  stale: "快照不对应前一交易日",
  "delayed-signal": "延迟或重放信号，未补写结构",
};
const isoTime = (stamp: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/.test(stamp)
    ? Date.parse(stamp)
    : NaN;
export const nyDay = (stamp: number) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(stamp);
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date;

/** Cboe timezone-less quotes are NY wall time. Match offsets rather than assume permanent EST. */
export function quoteTimestamp(stamp?: string): number | null {
  if (!stamp) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(stamp)) {
    const value = isoTime(stamp);
    return Number.isFinite(value) ? value : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(stamp))
    return null;
  const wall = stamp.slice(0, 19),
    base = Date.parse(`${stamp}Z`);
  if (!Number.isFinite(base)) return null;
  const format = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const candidates = [4, 5]
    .map((h) => base + h * 3600_000)
    .filter((t) => format.format(t).replace(" ", "T") === wall);
  // Ambiguous/nonexistent DST wall times fail closed.
  return candidates.length === 1 ? candidates[0] : null;
}

/** Publication happens now; never borrow an old review.builtAt for freshly reconstructed fields. */
export function makeOptionsPublication(
  reviewDate: string,
  rows: OptionsRow[],
  publishedAt: string,
  validForSession: string,
): OptionsPublication | null {
  const published = isoTime(publishedAt);
  if (
    !validDate(reviewDate) ||
    !validDate(validForSession) ||
    validForSession <= reviewDate ||
    !Number.isFinite(published)
  )
    return null;
  const items = OPTION_SYMBOLS.map((symbol) => {
    const row = rows.find((r) => r.symbol === symbol);
    const stamp = quoteTimestamp(row?.today?.as_of);
    const raw =
      stamp != null && stamp <= published && nyDay(stamp) === reviewDate
        ? structuredClone(row!.today)
        : null;
    return {
      symbol,
      dte: row?.dte ?? null,
      raw,
      structure: optionsStructure(raw, row?.meta, "snapshot"),
    };
  });
  return {
    version: "options-publication-v1",
    id: `${reviewDate}@${publishedAt}`,
    reviewDate,
    validForSession,
    publishedAt,
    items,
  };
}

export function missingOptionsContext(
  signalTime: number,
  frozenAt: string,
  reason: OptionsUnavailableReason,
): SignalOptionsContext {
  return {
    version: "signal-options-v1",
    mode: "previous-session",
    signalTime,
    frozenAt,
    status: "missing",
    reason,
    publication: null,
  };
}

/** No future publication, stale session, future quote, or reconstructed historical signal label. */
export function freezeOptionsContext(
  publication: OptionsPublication | null,
  signalTime: number,
  frozenAt: string,
  expectedDate?: string,
): SignalOptionsContext {
  const fail = (reason: OptionsUnavailableReason) =>
    missingOptionsContext(signalTime, frozenAt, reason);
  const captured = isoTime(frozenAt);
  if (!Number.isFinite(signalTime) || !Number.isFinite(captured))
    return fail("invalid");
  if (captured < signalTime - 60_000 || captured > signalTime + 15 * 60_000)
    return fail("delayed-signal");
  if (!publication) return fail("not-published");
  const published = isoTime(publication.publishedAt);
  if (
    publication.version !== "options-publication-v1" ||
    !validDate(publication.reviewDate) ||
    !validDate(publication.validForSession) ||
    !Number.isFinite(published) ||
    !Array.isArray(publication.items) ||
    publication.items.length !== 4
  )
    return fail("invalid");
  if (published > Math.min(signalTime, captured)) return fail("future");
  if (
    publication.validForSession !== nyDay(signalTime) ||
    publication.reviewDate >= publication.validForSession ||
    (expectedDate && publication.reviewDate !== expectedDate)
  )
    return fail("stale");
  const seen = new Set<string>();
  for (const item of publication.items) {
    if (
      !item ||
      !OPTION_SYMBOLS.includes(item.symbol) ||
      seen.has(item.symbol) ||
      item.structure?.version !== OPTIONS_STRUCTURE_VERSION ||
      item.structure.basis !== "snapshot" ||
      !Number.isFinite(item.structure.nearPct) ||
      item.structure.nearPct < 0
    )
      return fail("invalid");
    seen.add(item.symbol);
    const fetchedAt = item.structure.provenance?.fetched_at;
    if (fetchedAt) {
      const fetched = isoTime(fetchedAt);
      if (!Number.isFinite(fetched)) return fail("invalid");
      if (fetched > published) return fail("future");
    }
    if (item.raw) {
      const quoted = quoteTimestamp(item.raw.as_of);
      if (
        quoted == null ||
        nyDay(quoted) !== publication.reviewDate ||
        item.raw.symbol !== item.symbol
      )
        return fail("invalid");
      if (quoted > published) return fail("future");
    }
    // The stored state must correspond to exactly these raw values and rules.
    try {
      const derived = optionsStructure(
        item.raw,
        item.structure.provenance,
        "snapshot",
        item.structure.nearPct,
      );
      if (JSON.stringify(derived) !== JSON.stringify(item.structure))
        return fail("invalid");
    } catch {
      return fail("invalid");
    }
  }
  const complete = publication.items.every(
    (i) =>
      i.raw &&
      i.structure.flip !== "unknown" &&
      i.structure.wall !== "unknown" &&
      i.structure.gamma !== "unknown",
  );
  return {
    version: "signal-options-v1",
    mode: "previous-session",
    signalTime,
    frozenAt,
    status: complete ? "available" : "partial",
    publication: structuredClone(publication),
  };
}

/** Audit an already-frozen context without consulting today's files. */
export function validFrozenOptions(
  context: SignalOptionsContext | undefined,
  signalTime: number,
  capturedAt?: string,
): OptionsPublication | null {
  if (
    !context ||
    context.version !== "signal-options-v1" ||
    context.mode !== "previous-session" ||
    context.status === "missing" ||
    context.signalTime !== signalTime ||
    (capturedAt && context.frozenAt !== capturedAt)
  )
    return null;
  try {
    return freezeOptionsContext(
      context.publication,
      signalTime,
      context.frozenAt,
    ).publication;
  } catch {
    return null;
  }
}
