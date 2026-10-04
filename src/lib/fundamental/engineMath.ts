import { createHash } from "node:crypto";

export const DAY = 86_400_000;
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const day = (date: Date) => date.toISOString().slice(0, 10);
export const nextDay = (date: string) => day(new Date(Date.parse(date) + DAY));

/** Calendar months, clamped to the last day rather than overflowing into the next month. */
export function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`), original = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(original, last));
  return day(d);
}

export const quantile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b), pos = (sorted.length - 1) * p, low = Math.floor(pos);
  return sorted[low] + (sorted[Math.ceil(pos)] - sorted[low]) * (pos - low);
};
