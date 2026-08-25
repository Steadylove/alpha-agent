import type { MembershipSpan } from "./engine";
import { SMALL_FUND_UNIVERSE } from "./smallFundUniverse";

export type LiveBookAction = "add" | "remove";

export type LiveBookChange = {
  id: string;
  ticker: string;
  action: LiveBookAction;
  date: string;
  reason: string;
  at: string;
};

export function extraLiveTickers(changes: readonly LiveBookChange[]): string[] {
  const known = new Set(SMALL_FUND_UNIVERSE);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ch of changes) {
    if (ch.action !== "add" || known.has(ch.ticker) || seen.has(ch.ticker)) continue;
    seen.add(ch.ticker);
    out.push(ch.ticker);
  }
  return out;
}

function dayBefore(date: string): string {
  const day = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

export function inLiveSpan(date: string, spans: readonly MembershipSpan[]): boolean {
  return spans.some((s) => date >= s.start && (s.end == null || date <= s.end));
}

export function applyLiveBookChanges(
  membership: Map<string, MembershipSpan[]>,
  changes: readonly LiveBookChange[],
): Map<string, MembershipSpan[]> {
  const out = new Map<string, MembershipSpan[]>();
  for (const [ticker, spans] of membership) {
    out.set(
      ticker,
      spans.map((s) => ({ start: s.start, end: s.end })),
    );
  }

  const sorted = [...changes].sort((a, b) =>
    a.date === b.date ? a.at.localeCompare(b.at) : a.date.localeCompare(b.date),
  );

  for (const ch of sorted) {
    const spans = out.get(ch.ticker) ?? [];
    if (ch.action === "add") {
      if (spans.some((s) => s.end == null)) continue;
      spans.push({ start: ch.date, end: null });
      out.set(ch.ticker, spans);
      continue;
    }
    const open = [...spans].reverse().find((s) => s.end == null);
    if (!open) continue;
    const last = dayBefore(ch.date);
    if (last < open.start) {
      out.set(
        ch.ticker,
        spans.filter((s) => s !== open),
      );
    } else {
      open.end = last;
      out.set(ch.ticker, spans);
    }
  }
  return out;
}
