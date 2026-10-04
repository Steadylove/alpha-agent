import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });

/** Generic inputs must already carry a timezone; never infer a date-only entry. */
export function fundamentalEntryAt(raw: string | null | undefined, now = Date.now()): string | null {
  const parsed = timestamp.safeParse(raw);
  if (!parsed.success) return null;
  const value = Date.parse(parsed.data);
  return Number.isFinite(value) && value <= now ? new Date(value).toISOString() : null;
}

/** Provenance-specific: intraday model fills are stored as UTC bar opens, sometimes without Z. */
export function fundamentalBookEntryAt(raw: string | null | undefined, now = Date.now()): string | null {
  if (!raw) return null;
  const value = raw.trim();
  const utcClock = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value);
  return fundamentalEntryAt(utcClock ? `${value}Z` : value, now);
}

/** JournalSignal.signalTime is an epoch millisecond signal timestamp, not capturedAt. */
export function fundamentalSignalEntryAt(value: number, now = Date.now()): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > now) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function fundamentalUrl(symbol: string, entryAt?: string | null, api = false): string {
  const base = `${api ? "/api" : ""}/fundamental/${encodeURIComponent(symbol)}`;
  const at = fundamentalEntryAt(entryAt);
  return `${base}${at ? `?${new URLSearchParams({ entryAt: at })}` : ""}`;
}
