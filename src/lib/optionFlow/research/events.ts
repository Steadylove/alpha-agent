import { createHash } from "node:crypto";
import { flowLean, flowSide, type FlowSide } from "../direction";
import { isOptionSessionPosted } from "../config";
import type { OptionFlowPost } from "../types";

export type FlowEvent = {
  id: string; day: string; ticker: string; right: "call" | "put"; strike: number | null;
  expiry: string | null; side: FlowSide; direction: "bull" | "bear" | "unknown";
  premium: number | null; postedAt: string; ingestedAt: string; sourceUrl: string | null;
  sourceIds: string[]; rawText: string; flags: string[];
};
export const nyDay = (at: string) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(at));
export function isFlowSource(post: OptionFlowPost) {
  return /^FL0WG0D$/i.test(post.handle ?? "") || /^https:\/\/(?:x|twitter)\.com\/FL0WG0D\//i.test(post.tweetUrl ?? "");
}
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 20);

/** Deduplicate reports, not contracts. Recaps / OI confirmations are not new trades. */
export function normalizeFlowEvents(posts: readonly OptionFlowPost[], sessions: readonly string[]) {
  const validDays = new Set(sessions);
  const grouped = new Map<string, OptionFlowPost[]>();
  const observed = new Set<string>();
  const excluded: Record<string, number> = {};
  const skip = (day: string) => { excluded[day] = (excluded[day] ?? 0) + 1; };
  for (const post of posts) {
    if (!isFlowSource(post) || !Number.isFinite(Date.parse(post.postedAt))) continue;
    const day = nyDay(post.postedAt);
    if (!validDays.has(day)) continue;
    observed.add(day);
    if (post.kind !== "flow" || /noteworthy flow|oi confirmed|recap|dark pool/i.test(`${post.thesis} ${post.rawText}`) || !isOptionSessionPosted(post.postedAt)) { skip(day); continue; }
    const key = post.tweetId ? `tweet:${post.tweetId}` : `message:${post.id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), post]);
  }
  const events: FlowEvent[] = [];
  for (const [key, copies] of grouped) {
    const post = [...copies].sort((a, b) => b.legs.length - a.legs.length)[0];
    const earliest = [...copies].sort((a, b) => a.postedAt.localeCompare(b.postedAt))[0];
    const day = nyDay(earliest.postedAt);
    const rawText = post.rawText || post.thesis;
    const unique = new Set<string>();
    const legs = post.legs.filter(l => /^[A-Z][A-Z0-9.-]{0,9}$/.test(l.ticker) && (l.right === "call" || l.right === "put"));
    for (const leg of legs) {
      // Keep distinct expiries / executions. Never fill a vague expiry with an invented third Friday.
      const identity = JSON.stringify([leg.ticker, leg.right, leg.strike, leg.expiry, leg.note, leg.premiumUsd]);
      if (unique.has(identity)) continue;
      unique.add(identity);
      const sharedAmount = legs.length > 1 && legs.some(other => other !== leg && other.premiumUsd === leg.premiumUsd);
      const side = flowSide(legs.length === 1 ? rawText : "", leg.note);
      const premium = !sharedAmount && Number.isFinite(leg.premiumUsd) && leg.premiumUsd! > 0 ? leg.premiumUsd! : null;
      events.push({ id: fingerprint(`${key}|${identity}`), day, ticker: leg.ticker, right: leg.right!,
        strike: Number.isFinite(leg.strike) && leg.strike! > 0 ? leg.strike! : null,
        expiry: leg.expiry || null, side, direction: flowLean(leg.right, side) ?? "unknown", premium,
        postedAt: earliest.postedAt, ingestedAt: post.ingestedAt, sourceUrl: /^https:\/\/(?:x|twitter)\.com\//i.test(post.tweetUrl ?? "") ? post.tweetUrl! : null,
        sourceIds: copies.map(p => p.id), rawText,
        flags: [...(side === "unknown" ? ["买卖方向未明"] : []), ...(sharedAmount ? ["多腿金额归属不明"] : []), ...(!leg.expiry || !leg.strike ? ["合约字段不完整"] : [])],
      });
    }
    if (!legs.length) skip(day);
  }
  return { events: events.sort((a, b) => a.postedAt.localeCompare(b.postedAt) || a.id.localeCompare(b.id)), observed: [...observed].sort(), excluded };
}
