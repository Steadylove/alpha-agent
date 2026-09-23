import type { OptionFlowLeg } from "./types";

export type FlowSide = "buyer" | "seller" | "unknown";
export type FlowLean = "bull" | "bear";

/** A source label, never an inference about position intent or opening/closing. */
export function flowSide(text: string, note?: string): FlowSide {
  if (note === "buyer" || note === "seller" || note === "unknown") return note;
  const buy = /\b(?:buyers?|buying|bought)\b/i.test(text);
  const sell = /\b(?:sellers?|selling|sold)\b/i.test(text);
  return buy === sell ? "unknown" : buy ? "buyer" : "seller";
}
export function flowLean(right?: OptionFlowLeg["right"], side?: FlowSide): FlowLean | undefined {
  if (!right || !side || side === "unknown") return undefined;
  return (right === "call") === (side === "buyer") ? "bull" : "bear";
}
export function sideLabel(leg: Pick<OptionFlowLeg, "right" | "note">): string {
  const prefix = leg.note === "buyer" ? "买" : leg.note === "seller" ? "卖" : "方向未明";
  return `${prefix}${leg.right ? ` ${leg.right.toUpperCase()}` : ""}`;
}
