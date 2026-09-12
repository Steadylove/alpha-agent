import type { OptionFlowConfig } from "./types";

export const DEFAULT_OPTION_CHANNEL_ID = "1546768709735948378";

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
  if (post.kind !== "flow") return false;
  const leg = post.legs[0];
  if (!leg || !isCompleteLeg(leg)) return false;
  if (cfg.minPremiumUsd <= 0) return true;
  return (leg.premiumUsd ?? 0) >= cfg.minPremiumUsd;
}
