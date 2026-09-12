export function rpsDelta(today: number | null | undefined, prev: number | null | undefined): number | null {
  if (today == null || prev == null) return null;
  return today - prev;
}
