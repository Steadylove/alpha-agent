export type OhlcvBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * 美东已收盘日。16:15 之前不算当天，避免把未完成的日线写进面板。
 */
export function lastSettledNyDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const num = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const y = num("year");
  const m = num("month");
  const d = num("day");
  const hour = num("hour");
  const minute = num("minute");
  const settled = hour > 16 || (hour === 16 && minute >= 15);
  if (settled) return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const prev = new Date(Date.UTC(y, m - 1, d));
  prev.setUTCDate(prev.getUTCDate() - 1);
  return prev.toISOString().slice(0, 10);
}

/** 已有序列后追加新日期。同日保留旧值，不回写未完成的当天。 */
export function mergeNewBars(
  existing: readonly OhlcvBar[],
  incoming: readonly OhlcvBar[],
  until: string,
): OhlcvBar[] {
  const have = new Set(existing.map((b) => b.date));
  const extra = incoming.filter((b) => b.date.slice(0, 10) <= until && !have.has(b.date));
  if (extra.length === 0) return [...existing];
  return [...existing, ...extra].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
