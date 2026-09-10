import type { OptionFlowKind, OptionFlowLeg, OptionRight } from "./types";

const AD_RE =
  /labor\s*day|get funded|70%\s*off|35%\s*off|cheddarflow\.co|optionsfunding|free trial|bullflow(?:'s)? (?:labor|plan|api)|sale continues|want to see trades like this/i;
const PAID_RE = /posted a tweet for paid guys|🔒/;
const NOTEWORTHY_RE = /noteworthy flow|oi confirmed/i;
const GEX_RE = /\b(?:heatmaps?|gamma|gex|put wall)\b/i;
const LINE_RE =
  /\$([A-Z]{1,5})\s+(\d+(?:\.\d+)?)\s+(Call|Put)s?\s+\((\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\)\s*[-–]\s*(\$?[\d.]+(?:\s*(?:K|M|B|million|billion))?)\s*(?:@\s*([\d.]+))?/gi;
const CALL_BUYER_RE = /\$([A-Z]{1,5})\s*[-–]\s*\$?\s*([\d.]+)\s*(K|M|B|million|billion)?\s+(Call|Put)\s+(buyer|seller)/i;
const INTO_RE =
  /\$?\s*([\d.]+)\s*(K|M|B|million|billion)\+?\s+(?:worth of\s+)?(?:into these\s+)?\$([A-Z]{1,5})\s+(calls?|puts?)/i;
const INTO_FRONT_RE =
  /\$([A-Z]{1,5}).{0,40}?(?:\$?\s*([\d.]+)\s*(K|M|B|million|billion)\+?).{0,20}(calls?|puts?)/i;
const STRIKE_RE = /\$(\d+(?:\.\d+)?)\s+strike/i;
const TICKER_RE = /\$([A-Z]{1,5})\b/g;

const MONTHS: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

export function parsePremiumUsd(raw: string): number | undefined {
  const cleaned = raw.replace(/[~+,]/g, "").trim();
  const m = cleaned.match(/\$?\s*([\d.]+)\s*(billion|million|B|M|K)?\b/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? "").toUpperCase();
  if (unit === "B" || unit === "BILLION") return Math.round(n * 1e9);
  if (unit === "M" || unit === "MILLION") return Math.round(n * 1e6);
  if (unit === "K") return Math.round(n * 1e3);
  if (n >= 1000) return n;
  return undefined;
}

function rightOf(word: string): OptionRight {
  return /^puts?$/i.test(word) ? "put" : "call";
}

function expiryHint(text: string): string | undefined {
  if (/\bnext year\b/i.test(text)) return "next-year";
  const month = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  );
  if (month) return MONTHS[month[1].toLowerCase()];
  if (/\b0DTE\b/i.test(text)) return "0DTE";
  if (/\bLEAPS?\b/i.test(text)) return "LEAPS";
  return undefined;
}

function firstStrike(text: string): number | undefined {
  const m = text.match(STRIKE_RE);
  return m ? Number(m[1]) : undefined;
}

function uniqTickers(text: string): string[] {
  return [...new Set([...text.matchAll(TICKER_RE)].map((m) => m[1]))];
}

export function classifyKind(text: string, legs: OptionFlowLeg[]): OptionFlowKind {
  if (PAID_RE.test(text)) return "paid";
  if (AD_RE.test(text)) return "ad";
  if (NOTEWORTHY_RE.test(text) && legs.length > 0) return "noteworthy";
  if (GEX_RE.test(text) && !/call buyer|into these/i.test(text)) return "gex";
  if (legs.some((leg) => leg.right || leg.premiumUsd)) return "flow";
  return "other";
}

function noteworthyLegs(text: string): OptionFlowLeg[] {
  const legs: OptionFlowLeg[] = [];
  for (const m of text.matchAll(LINE_RE)) {
    legs.push({
      ticker: m[1],
      strike: Number(m[2]),
      right: rightOf(m[3]),
      expiry: m[4],
      premiumUsd: parsePremiumUsd(m[5]),
      optionPrice: m[6] ? Number(m[6]) : undefined,
    });
  }
  return legs;
}

function singleLeg(text: string): OptionFlowLeg | undefined {
  const buyer = text.match(CALL_BUYER_RE);
  if (buyer) {
    return {
      ticker: buyer[1],
      premiumUsd: parsePremiumUsd(`${buyer[2]}${buyer[3] ?? ""}`),
      right: rightOf(buyer[4]),
      note: buyer[5].toLowerCase(),
      strike: firstStrike(text),
      expiry: expiryHint(text),
    };
  }
  const into = text.match(INTO_RE);
  if (into) {
    return {
      ticker: into[3],
      premiumUsd: parsePremiumUsd(`${into[1]}${into[2]}`),
      right: rightOf(into[4]),
      strike: firstStrike(text),
      expiry: expiryHint(text),
    };
  }
  const front = text.match(INTO_FRONT_RE);
  if (front) {
    return {
      ticker: front[1],
      premiumUsd: parsePremiumUsd(`${front[2]}${front[3]}`),
      right: rightOf(front[4]),
      strike: firstStrike(text),
      expiry: expiryHint(text),
    };
  }
  return undefined;
}

export function extractLegs(text: string): OptionFlowLeg[] {
  const listed = noteworthyLegs(text);
  if (listed.length) return listed;
  const one = singleLeg(text);
  if (one) return [one];
  const tickers = uniqTickers(text);
  if (!tickers.length) return [];
  const premium = parsePremiumUsd(text.replace(STRIKE_RE, " "));
  const right = /\bputs?\b/i.test(text) && !/\bcalls?\b/i.test(text) ? "put" : /\bcalls?\b/i.test(text) ? "call" : undefined;
  if (!right && !premium) return tickers.map((ticker) => ({ ticker }));
  return tickers.map((ticker) => ({
    ticker,
    right,
    premiumUsd: premium,
    strike: firstStrike(text),
    expiry: expiryHint(text),
  }));
}

export function extractThesis(text: string): string {
  const line = text.split(/\n+/).map((s) => s.trim()).find((s) => s && !PAID_RE.test(s) && s !== "Heatmaps");
  return (line ?? text.trim()).slice(0, 200);
}

export function extractCard(text: string): { kind: OptionFlowKind; thesis: string; legs: OptionFlowLeg[] } {
  const legs = extractLegs(text);
  return { kind: classifyKind(text, legs), thesis: extractThesis(text), legs };
}
