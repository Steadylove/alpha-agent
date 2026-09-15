import type { OptionFlowConfig } from "./types";

export const DEFAULT_OPTION_CHANNEL_ID = "1546768709735948378";
const ET = "America/New_York";
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function etClock(iso: string): { weekday: number; minutes: number } | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const weekday = WEEKDAY[parts.find((p) => p.type === "weekday")?.value ?? ""];
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (weekday == null || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { weekday, minutes: hour * 60 + minute };
}

/** 美东周一至周五 09:30–16:00。盘前盘后和周末不转发、不进复盘。 */
export function isOptionSessionPosted(iso: string): boolean {
  const clock = etClock(iso);
  if (!clock || clock.weekday === 0 || clock.weekday === 6) return false;
  return clock.minutes >= 9 * 60 + 30 && clock.minutes < 16 * 60;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw == null || raw === "") return fallback;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  return fallback;
}

export function optionFlowConfig(): OptionFlowConfig {
  const premium = Number(process.env.OPTION_FLOW_MIN_PREMIUM_USD ?? "0");
  return {
    channelId: process.env.DISCORD_OPTION_CHANNEL_ID?.trim() || DEFAULT_OPTION_CHANNEL_ID,
    minPremiumUsd: Number.isFinite(premium) ? Math.max(0, premium) : 0,
    dropAds: boolEnv("OPTION_FLOW_DROP_ADS", true),
    dropPaid: boolEnv("OPTION_FLOW_DROP_PAID", true),
  };
}

/** 只有「次年 / LEAPS」这种没有窗口的到期，才算没写清。月份、两周、0DTE 可以转发。 */
export function isVagueExpiry(expiry?: string): boolean {
  return !expiry || /^(next-year|LEAPS)$/i.test(expiry);
}

export function isCalendarExpiry(expiry?: string): boolean {
  return Boolean(expiry && /\d{1,2}\/\d{1,2}/.test(expiry));
}

export function isCompleteLeg(leg: { ticker?: string; strike?: number; expiry?: string }): boolean {
  return Boolean(leg.ticker && leg.strike != null && !isVagueExpiry(leg.expiry));
}

export function shouldForward(
  post: { kind: string; legs: Array<{ ticker?: string; strike?: number; expiry?: string; premiumUsd?: number }> },
  cfg: Pick<OptionFlowConfig, "minPremiumUsd" | "dropAds" | "dropPaid">,
): boolean {
  if (cfg.dropPaid && post.kind === "paid") return false;
  if (cfg.dropAds && post.kind === "ad") return false;
  if (post.kind === "noteworthy") return post.legs.some((leg) => isCompleteLeg(leg) && (cfg.minPremiumUsd <= 0 || (leg.premiumUsd ?? 0) >= cfg.minPremiumUsd));
  if (post.kind === "gex") return post.legs.some((leg) => leg.strike != null);
  if (post.kind !== "flow") return false;
  const leg = post.legs[0];
  if (!leg || !isCompleteLeg(leg)) return false;
  if (cfg.minPremiumUsd <= 0) return true;
  return (leg.premiumUsd ?? 0) >= cfg.minPremiumUsd;
}
