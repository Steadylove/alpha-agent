import { lastSettledSession } from "@/lib/backtest/mergeBars";
import { fmtLevel, type GexSnapshot } from "@/lib/discord/gexCopy";

import { isCompleteLeg, isOptionSessionPosted } from "./config";
import { expirySpecificity, normalizeExpiry } from "./expiry";
import type { OptionFlowKind, OptionFlowLeg, OptionFlowPost } from "./types";

const NOTE_MAX = 3;
const BIAS_RATIO = 1.2;
const FLOW_KINDS = new Set<OptionFlowKind>(["flow", "noteworthy"]);

export type FlowDigestBias = "bull" | "bear" | "mixed" | "none";
export type FlowSide = "buyer" | "seller";
export type FlowLean = "bull" | "bear";

export type FlowDigestNote = {
  ticker: string;
  text: string;
};

export type FlowDigestWalls = {
  symbol: string;
  spot: string;
  flip: string;
  putWall: string;
  callWall: string;
};

export type FlowDigestView = {
  day: string;
  title: string;
  callUsd: number;
  putUsd: number;
  bullUsd: number;
  bearUsd: number;
  bias: FlowDigestBias;
  legs: OptionFlowLeg[];
  notes: FlowDigestNote[];
  spy: FlowDigestWalls | null;
};

export function etCalendarDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export function sessionDayFromSnapshot(snapshot?: GexSnapshot): string {
  const items = snapshot?.items ?? [];
  const asOf =
    items.find((row) => row.symbol === "SPY")?.as_of ??
    items.find((row) => row.symbol === "SPX")?.as_of ??
    items.find((row) => row.as_of)?.as_of;
  if (asOf && /^\d{4}-\d{2}-\d{2}/.test(asOf)) return asOf.slice(0, 10);
  return lastSettledSession();
}

export function spyWalls(snapshot?: GexSnapshot): FlowDigestWalls | null {
  const row = snapshot?.items?.find((item) => item.symbol === "SPY");
  if (!row) return null;
  return {
    symbol: "SPY",
    spot: fmtLevel(row.spot),
    flip: fmtLevel(row.gamma_flip),
    putWall: fmtLevel(row.put_wall),
    callWall: fmtLevel(row.call_wall),
  };
}

export function isUsefulNote(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 18) return false;
  if (/^-+$/.test(t) || /^heatmaps?$/i.test(t)) return false;
  if (/^noteworthy flow/i.test(t) || /^oi confirmed/i.test(t)) return false;
  if (/^(?:\$[A-Z]{1,5}\s+)?(?:0DTE\s+)?(?:put wall|call wall|gamma flip|heatmaps?)/i.test(t) && t.length < 48) return false;
  if (/^\d{3,4}(?:\.\d+)?\s+strongest nod/i.test(t) && t.length < 40) return false;
  if (/^\$[A-Z]{1,5}\s+\$?\d/i.test(t)) return false;
  if (/^\$[A-Z]{1,5}\s+[-–]/i.test(t) && t.length < 60) return false;
  if (/into these|call leaps|otm calls|otm \$/i.test(t) && /\$[\d.]|\d+\s*(K|M|million)/i.test(t)) return false;
  if (/^\$?[\d.]+\s*(K|M|B|million|billion)/i.test(t) && /into these|calls?\.?$|puts?\.?$/i.test(t)) return false;
  if (/^this is very unusual$/i.test(t) || /dark pool/i.test(t)) return false;
  if (/\b(call|put)\s+(buyer|seller)\b/i.test(t) && t.length < 50) return false;
  return (t.match(/[A-Za-z\u4e00-\u9fff]/g) ?? []).length >= 14;
}

export function hasDigestContent(view: FlowDigestView): boolean {
  return view.legs.length > 0 || view.spy != null;
}

export function digestTitle(day: string): string {
  const parts = day.split("-");
  const month = Number(parts[1]);
  const date = Number(parts[2]);
  if (!month || !date) return "期权流 · 日结";
  return `期权流 · ${month}月${date}日`;
}

export function flowSide(text: string, note?: string): FlowSide {
  if (note === "buyer" || note === "seller") return note;
  if (/\bsellers?\b/i.test(text) && !/\bbuyers?\b/i.test(text)) return "seller";
  if (/\bbuyers?\b/i.test(text) && !/\bsellers?\b/i.test(text)) return "buyer";
  return "buyer";
}

export function flowLean(right?: OptionFlowLeg["right"], side?: FlowSide): FlowLean | undefined {
  if (!right || !side) return undefined;
  if (right === "call") return side === "seller" ? "bear" : "bull";
  return side === "seller" ? "bull" : "bear";
}

export function sideLabel(leg: Pick<OptionFlowLeg, "right" | "note">): string {
  const side = leg.note === "seller" ? "卖" : "买";
  if (leg.right === "put") return `${side} PUT`;
  if (leg.right === "call") return `${side} CALL`;
  return side;
}

export function biasLabel(view: Pick<FlowDigestView, "bias">): string {
  if (view.bias === "bull") return "当日大额偏看涨";
  if (view.bias === "bear") return "当日大额偏看跌";
  if (view.bias === "mixed") return "看涨 / 看跌资金接近";
  return "当日无金额可加总";
}

export function flowDigestCaption(test: boolean): string {
  return test ? "期权流 · 日结（测试）" : "期权流 · 日结";
}

function isDigestLeg(leg: OptionFlowLeg): boolean {
  return Boolean(leg.right && isCompleteLeg(leg));
}

function contractKey(leg: OptionFlowLeg): string {
  return `${leg.ticker}|${leg.right ?? ""}|${leg.strike ?? ""}`;
}

function nearPremium(a?: number, b?: number): boolean {
  if (a == null || b == null) return false;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return hi > 0 && lo / hi >= 0.85;
}

function preferLeg(keep: OptionFlowLeg, incoming: OptionFlowLeg, day: string): OptionFlowLeg {
  const keepSpec = expirySpecificity(keep.expiry);
  const nextSpec = expirySpecificity(incoming.expiry);
  const richer = nextSpec > keepSpec ? incoming : keep;
  return {
    ...richer,
    expiry: normalizeExpiry(richer.expiry, day) ?? richer.expiry,
    premiumUsd: Math.max(keep.premiumUsd ?? 0, incoming.premiumUsd ?? 0) || richer.premiumUsd,
    note: keep.note === "seller" || incoming.note === "seller" ? "seller" : incoming.note ?? keep.note,
  };
}

function mergeLegs(legs: readonly OptionFlowLeg[], day: string): OptionFlowLeg[] {
  const grouped = new Map<string, OptionFlowLeg[]>();
  for (const leg of legs) {
    const key = contractKey(leg);
    grouped.set(key, [...(grouped.get(key) ?? []), { ...leg }]);
  }
  const collapsed: OptionFlowLeg[] = [];
  for (const group of grouped.values()) {
    const kept: OptionFlowLeg[] = [];
    for (const leg of group.sort((a, b) => expirySpecificity(b.expiry) - expirySpecificity(a.expiry))) {
      const twin = kept.find((row) => nearPremium(row.premiumUsd, leg.premiumUsd));
      if (twin) Object.assign(twin, preferLeg(twin, leg, day));
      else kept.push({ ...leg });
    }
    collapsed.push(...kept);
  }
  const exact = new Map<string, OptionFlowLeg>();
  for (const leg of collapsed) {
    const dated = { ...leg, expiry: normalizeExpiry(leg.expiry, day) ?? leg.expiry };
    const key = `${contractKey(dated)}|${dated.expiry ?? ""}`;
    const prev = exact.get(key);
    exact.set(key, prev ? preferLeg(prev, dated, day) : dated);
  }
  return [...exact.values()];
}

function isFlowGod(post: OptionFlowPost): boolean {
  if (/^FL0WG0D$/i.test(post.handle ?? "")) return true;
  return /(?:x|twitter)\.com\/FL0WG0D\//i.test(post.tweetUrl ?? "");
}

function uniqueSessionPosts(posts: readonly OptionFlowPost[], day: string): OptionFlowPost[] {
  const session = posts.filter((post) => FLOW_KINDS.has(post.kind) && isFlowGod(post) && etCalendarDay(post.postedAt) === day && isOptionSessionPosted(post.postedAt));
  const byTweet = new Map<string, OptionFlowPost>();
  const leftover: OptionFlowPost[] = [];
  for (const post of session) {
    if (!post.tweetId) {
      leftover.push(post);
      continue;
    }
    const prev = byTweet.get(post.tweetId);
    if (!prev || post.legs.filter(isDigestLeg).length > prev.legs.filter(isDigestLeg).length) {
      byTweet.set(post.tweetId, post);
    }
  }
  return [...byTweet.values(), ...leftover];
}

function noteLine(post: OptionFlowPost): FlowDigestNote | null {
  if (!isUsefulNote(post.thesis)) return null;
  const ticker = post.legs[0]?.ticker ?? "";
  const text = post.thesis.replace(/\s+/g, " ").trim();
  return { ticker, text: text.length > 80 ? `${text.slice(0, 79)}…` : text };
}

function pickNotes(posts: readonly OptionFlowPost[], topTickers: ReadonlySet<string>): FlowDigestNote[] {
  const ranked = posts
    .map(noteLine)
    .filter((note): note is FlowDigestNote => note != null)
    .sort((a, b) => Number(topTickers.has(b.ticker)) - Number(topTickers.has(a.ticker)));
  const notes: FlowDigestNote[] = [];
  const seen = new Set<string>();
  for (const note of ranked) {
    const key = `${note.ticker}|${note.text}`.toLowerCase();
    if (seen.has(key)) continue;
    if (topTickers.size > 0 && note.ticker && !topTickers.has(note.ticker)) continue;
    seen.add(key);
    notes.push(note);
    if (notes.length >= NOTE_MAX) break;
  }
  return notes;
}

function biasOf(bullUsd: number, bearUsd: number): FlowDigestBias {
  if (bullUsd <= 0 && bearUsd <= 0) return "none";
  if (bullUsd >= bearUsd * BIAS_RATIO) return "bull";
  if (bearUsd >= bullUsd * BIAS_RATIO) return "bear";
  return "mixed";
}

export function buildDailyFlowDigest(
  posts: readonly OptionFlowPost[],
  snapshot?: GexSnapshot,
  day = sessionDayFromSnapshot(snapshot),
): FlowDigestView {
  const session = uniqueSessionPosts(posts, day);
  const rawLegs = session.flatMap((post) => post.legs.filter(isDigestLeg).map((leg) => ({
    ...leg,
    note: flowSide(`${post.thesis}\n${post.rawText}`, leg.note),
  })));
  const merged = mergeLegs(rawLegs, day).sort((a, b) => (b.premiumUsd ?? 0) - (a.premiumUsd ?? 0) || a.ticker.localeCompare(b.ticker));
  const legs = merged;
  const callUsd = merged.filter((leg) => leg.right === "call").reduce((sum, leg) => sum + (leg.premiumUsd ?? 0), 0);
  const putUsd = merged.filter((leg) => leg.right === "put").reduce((sum, leg) => sum + (leg.premiumUsd ?? 0), 0);
  const bullUsd = merged.filter((leg) => flowLean(leg.right, flowSide("", leg.note)) === "bull").reduce((sum, leg) => sum + (leg.premiumUsd ?? 0), 0);
  const bearUsd = merged.filter((leg) => flowLean(leg.right, flowSide("", leg.note)) === "bear").reduce((sum, leg) => sum + (leg.premiumUsd ?? 0), 0);
  return {
    day,
    title: digestTitle(day),
    callUsd,
    putUsd,
    bullUsd,
    bearUsd,
    bias: biasOf(bullUsd, bearUsd),
    legs,
    notes: pickNotes(session, new Set(legs.map((leg) => leg.ticker))),
    spy: sessionDayFromSnapshot(snapshot) === day ? spyWalls(snapshot) : null,
  };
}
