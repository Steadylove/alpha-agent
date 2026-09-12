import { isCalendarExpiry } from "./config";
import type { OptionFlowLeg, OptionRight } from "./types";

const HEAD_RE = /^([A-Z]{1,5})\s+(\d+(?:\.\d+)?)\s+(Call|Put)\b/im;
const EXP_RE = /Exp(?:iration)?\.?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/im;
const PREM_RE = /^Prem(?:ium)?[:\s]+\$?([\d.]+)\s*(K|M|B)/im;
const OTM_RE = /^OTM[:\s]+([\d.]+)\s*%/im;

function premiumOf(n: string, unit: string): number {
  const value = Number(n);
  const scale = unit.toUpperCase() === "B" ? 1e9 : unit.toUpperCase() === "M" ? 1e6 : 1e3;
  return Math.round(value * scale);
}

export function parseChartText(text: string): Partial<OptionFlowLeg> | null {
  const head = text.match(HEAD_RE);
  if (!head) return null;
  const expiry = text.match(EXP_RE)?.[1];
  const prem = text.match(PREM_RE);
  const otm = text.match(OTM_RE);
  return {
    ticker: head[1],
    strike: Number(head[2]),
    right: head[3].toLowerCase() as OptionRight,
    expiry,
    premiumUsd: prem ? premiumOf(prem[1], prem[2]) : undefined,
    otmPct: otm ? Number(otm[1]) : undefined,
  };
}

export function mergeChartLeg(leg: OptionFlowLeg, chart: Partial<OptionFlowLeg>): OptionFlowLeg {
  const same = !chart.ticker || chart.ticker === leg.ticker;
  return {
    ...leg,
    ticker: same ? leg.ticker : chart.ticker ?? leg.ticker,
    right: leg.right ?? chart.right,
    strike: leg.strike ?? chart.strike,
    expiry: isCalendarExpiry(leg.expiry) ? leg.expiry : chart.expiry ?? leg.expiry,
    premiumUsd: leg.premiumUsd ?? chart.premiumUsd,
    otmPct: leg.otmPct ?? chart.otmPct,
  };
}
