/** Client-safe display helpers; all values retain their saved dates. */
export function contextHref(symbol: string, date: string): string {
  return `/context/${encodeURIComponent(symbol)}?date=${encodeURIComponent(date)}`;
}
export const contextEvidenceId = (id: string): string => `context-${id}`;

export function contextTime(value: string | null | undefined): string {
  if (!value) return "时间未留档";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value} · 具体时间未提供`;
  return Number.isFinite(Date.parse(value))
    ? `${new Intl.DateTimeFormat("zh-CN", {
        timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      }).format(new Date(value))} ET`
    : "时间未留档";
}

export function contextNumber(value: number | null | undefined, suffix = "", signed = false): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const n = Number(value.toFixed(2));
  return `${signed && n > 0 ? "+" : ""}${n.toFixed(2)}${suffix}`;
}

export function contextMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 1e6 ? `$${(value / 1e6).toFixed(2)}M`
    : value >= 1e3 ? `$${(value / 1e3).toFixed(1)}K` : `$${value.toFixed(0)}`;
}

export function contextSourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname)) return null;
    return url.toString();
  } catch { return null; }
}
