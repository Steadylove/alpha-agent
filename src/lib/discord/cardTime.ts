/** 卡片时间换成读者能认的时区名，不写 UTC。 */

export const CARD_TZ_ET = "美东时间";
export const CARD_TZ_BJ = "北京时间";

export function stampClock(iso: string): string {
  return iso.replace("T", " ").replace(/Z$/, "").slice(0, 16);
}

export function withTimeZone(clock: string, zone: string): string {
  if (!clock || clock === "—") return clock;
  if (/(?:美东时间|北京时间|美东)\s*$/.test(clock)) return clock;
  return `${clock} ${zone}`;
}

function parseUtc(iso: string): Date | null {
  const raw = iso.trim();
  if (!raw || raw === "—") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const hasZone = /Z|[+-]\d{2}:\d{2}$/.test(raw);
  const t = Date.parse(hasZone ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? new Date(t) : null;
}

function formatInZone(iso: string, timeZone: string, label: string): string {
  const date = parseUtc(iso);
  if (!date) {
    const clock = stampClock(iso);
    return /^\d{4}-\d{2}-\d{2}$/.test(clock) ? clock : withTimeZone(clock, label);
  }
  const clock = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date).replace(", ", " ");
  return `${clock} ${label}`;
}

/** 账本 K 线按 UTC 存储，展示换算成美东墙钟。 */
export function formatEtFromUtc(iso: string): string {
  return formatInZone(iso, "America/New_York", CARD_TZ_ET);
}

/** Discord / X 发布时间按 UTC 存储，展示换成北京时间。 */
export function formatBeijingFromUtc(iso: string): string {
  return formatInZone(iso, "Asia/Shanghai", CARD_TZ_BJ);
}

/** GEX 快照本身已是美东墙钟。 */
export function formatEtStamp(iso: string): string {
  return withTimeZone(stampClock(iso), CARD_TZ_ET);
}
