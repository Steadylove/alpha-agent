import { isCalendarExpiry } from "./config";
import type { OptionFlowLeg, OptionRight } from "./types";

const HEAD_RE = /^([A-Z]{1,5})\s+(\d+(?:\.\d+)?)\s+(Call|Put)\b/im;
const TABLE_RE = /^([A-Z]{1,5})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d+(?:\.\d+)?)\s+(Call|Put)\b/im;
const EXP_RE = /Exp(?:iration)?[.:]?\s*((?:\d{1,2}\/\d{1,2}\/\d{2,4})|(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{2,4})))\b/im;
const PREM_RE = /^Prem(?:ium)?[:\s]+\$?([\d.]+)\s*(K|M|B)/im;
const OTM_RE = /^OTM[:\s]+[+−-]?([\d.]+)\s*%/im;
const UNDERLYING_RE = /\bUnderlying\s*:\s*\$?([\d.]+)/i;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function englishExpiry(raw: string): string | undefined {
  const match = raw.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+)(\d{2,4})$/);
  if (!match) return undefined;
  const month = MONTHS[match[1].toLowerCase()];
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const day = Number(match[2]);
  if (!month || year < 2000 || year > 2199) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return undefined;
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
}

function premiumOf(n: string, unit: string): number {
  const value = Number(n);
  const scale = unit.toUpperCase() === "B" ? 1e9 : unit.toUpperCase() === "M" ? 1e6 : 1e3;
  return Math.round(value * scale);
}

export function parseChartText(text: string): Partial<OptionFlowLeg> | null {
  const table = text.match(TABLE_RE);
  if (table) {
    return {
      ticker: table[1],
      expiry: table[2],
      strike: Number(table[3]),
      right: table[4].toLowerCase() as OptionRight,
    };
  }
  const head = text.match(HEAD_RE);
  if (!head) return null;
  const rawExpiry = text.match(EXP_RE)?.[1];
  const expiry = rawExpiry && rawExpiry.includes("/") ? rawExpiry : rawExpiry ? englishExpiry(rawExpiry) : undefined;
  const prem = text.match(PREM_RE);
  const otm = text.match(OTM_RE);
  let otmPct = otm ? Number(otm[1]) : undefined;
  const underlying = Number(text.match(UNDERLYING_RE)?.[1]);
  if (otmPct != null && Number.isFinite(underlying) && underlying > 0) {
    const calculated = head[3].toLowerCase() === "call"
      ? (Number(head[2]) / underlying - 1) * 100
      : (1 - Number(head[2]) / underlying) * 100;
    // OCR occasionally reads the leading “+” as an extra 4 (43.1 → 443.1).
    if (Number.isFinite(calculated) && calculated >= 0 && Math.abs(otmPct - calculated) > 2) {
      otmPct = Number(calculated.toFixed(1));
    }
  }
  return {
    ticker: head[1],
    strike: Number(head[2]),
    right: head[3].toLowerCase() as OptionRight,
    expiry,
    premiumUsd: prem ? premiumOf(prem[1], prem[2]) : undefined,
    otmPct,
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
