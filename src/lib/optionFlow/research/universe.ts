import type { OptionFlowPost } from "../types";
import { isFlowSource } from "./events";

/** Daily bars only. These research symbols never enter the trading pool. */
export function flowResearchSymbols(posts: readonly OptionFlowPost[], through: string): string[] {
  const from = new Date(Date.parse(`${through}T00:00:00Z`) - 60 * 86400000).toISOString().slice(0, 10);
  return [...new Set(posts.filter(p => isFlowSource(p) && p.kind === "flow" && p.postedAt.slice(0, 10) >= from && p.postedAt.slice(0, 10) <= through)
    .flatMap(p => p.legs.filter(l => l.right && /^[A-Z][A-Z0-9.-]{0,9}$/.test(l.ticker)).map(l => l.ticker)))].sort();
}
