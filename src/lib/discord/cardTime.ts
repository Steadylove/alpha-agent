/** 卡片只标注原始墙钟所属时区，不改换算。 */

export const CARD_TZ_UTC = "UTC";
export const CARD_TZ_ET = "美东";

export function stampClock(iso: string): string {
  return iso.replace("T", " ").replace(/Z$/, "").slice(0, 16);
}

export function withTimeZone(clock: string, zone: string): string {
  if (!clock || clock === "—") return clock;
  if (/(?:UTC|美东|[+-]\d{2}:\d{2})\s*$/.test(clock)) return clock;
  return `${clock} ${zone}`;
}

/** 账本 K 线和 Discord 时间戳按 UTC 墙钟存储。 */
export function formatUtcStamp(iso: string): string {
  const offset = iso.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1];
  const clock = stampClock(iso);
  if (/^\d{4}-\d{2}-\d{2}$/.test(clock)) return clock;
  if (offset && offset !== "Z" && offset !== "+00:00") return `${clock} ${offset}`;
  return withTimeZone(clock, CARD_TZ_UTC);
}

/** GEX / 市场结构快照用美东墙钟。 */
export function formatEtStamp(iso: string): string {
  return withTimeZone(stampClock(iso), CARD_TZ_ET);
}
