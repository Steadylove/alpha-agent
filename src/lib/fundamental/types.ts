import { z } from "zod";

export const FUNDAMENTAL_VERSION = 1 as const;
export const FUNDAMENTAL_RULE = "forward-peer-pe-v1" as const;
export const SCENARIO_WEIGHTS = { bear: 0.2, base: 0.55, bull: 0.25 } as const;
export const symbolSchema = z.string().regex(/^[A-Z][A-Z0-9.-]{0,14}$/);
export const daySchema = z.iso.date();
const finite = z.number().finite();
const optionalNumber = finite.nullable();
const publicUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password &&
    ![...url.searchParams.keys()].some(key => /key|token|secret|auth/i.test(key));
}, "Only public HTTPS evidence URLs are allowed");

export const sourceSchema = z.object({
  id: z.string().min(1).max(120), label: z.string().min(1).max(200), url: publicUrl,
  observedAt: z.iso.datetime(), publishedAt: z.string().nullable(),
}).strict();
export type FundamentalSource = z.infer<typeof sourceSchema>;

export const estimateSchema = z.object({
  fiscalEnd: daySchema, epsLow: optionalNumber, epsAvg: optionalNumber, epsHigh: optionalNumber,
  revenueAvg: optionalNumber, analystCount: z.number().int().nonnegative(), sourceId: z.string(),
}).strict();
export type AnnualEstimate = z.infer<typeof estimateSchema>;

export const financialsSchema = z.object({
  fiscalEnd: daySchema, filedAt: daySchema, currency: z.string(),
  revenue: optionalNumber, netIncome: optionalNumber, operatingIncome: optionalNumber,
  reportedEps: optionalNumber, freeCashFlow: optionalNumber, cash: optionalNumber,
  debt: optionalNumber, dilutedWeightedShares: optionalNumber,
  latestQuarter: z.object({ fiscalEnd: daySchema, filedAt: daySchema, eps: optionalNumber }).nullable(),
  sourceIds: z.array(z.string()),
}).strict();
export type FundamentalFinancials = z.infer<typeof financialsSchema>;

export const peerSchema = z.object({
  symbol: symbolSchema, industry: z.string(), currency: z.string(), price: finite.positive(),
  observedAt: z.iso.datetime(), estimates: z.array(estimateSchema).max(12), sourceIds: z.array(z.string()),
}).strict();
export type FundamentalPeer = z.infer<typeof peerSchema>;

export const inputSchema = z.object({
  version: z.literal(1), symbol: symbolSchema, companyName: z.string(), sector: z.string(), industry: z.string(),
  currency: z.string(), isEtf: z.boolean(), isAdr: z.boolean(), observedAt: z.iso.datetime(),
  quote: z.object({ price: finite.positive(), observedAt: z.iso.datetime() }).nullable(),
  earningsBasis: z.literal("non-gaap-consensus"), financials: financialsSchema.nullable(),
  estimates: z.array(estimateSchema).max(12), peers: z.array(peerSchema).max(8),
  sources: z.array(sourceSchema).max(80), warnings: z.array(z.string().max(500)).max(40),
}).strict();
export type FundamentalInput = z.infer<typeof inputSchema>;

const scenarioSchema = z.object({
  eps: finite.positive(), multiple: finite.positive(), target: finite.positive(), weight: finite.min(0).max(1),
}).strict();
export const horizonSchema = z.object({
  months: z.union([z.literal(6), z.literal(12)]), targetDate: daySchema,
  earningsStart: daySchema, earningsEnd: daySchema,
  bear: scenarioSchema, base: scenarioSchema, bull: scenarioSchema,
  weightedTarget: finite.positive(), rangeLow: finite.positive(), rangeHigh: finite.positive(),
}).strict();
export type FundamentalHorizon = z.infer<typeof horizonSchema>;

const statementSchema = z.object({ text: z.string().min(1).max(500), sourceIds: z.array(z.string()).min(1).max(8) }).strict();
export const analystSchema = z.object({
  contractVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/).optional(),
  generatedAt: z.iso.datetime(), model: z.string(), inputHash: z.string(),
  summary: statementSchema, drivers: z.array(statementSchema).min(1).max(3),
  risks: z.array(statementSchema).min(1).max(5),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).nullable(),
}).strict();
export type FundamentalAnalyst = z.infer<typeof analystSchema>;

export const valuationSchema = z.object({
  version: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), rule: z.literal(FUNDAMENTAL_RULE),
  symbol: symbolSchema, publishedAt: z.iso.datetime(), anchorDate: daySchema,
  validUntil: z.iso.datetime(), inputHash: z.string(), input: inputSchema,
  method: z.literal("Forward P/E"), secondaryCheck: z.literal("Reported FCF / earnings quality"),
  peers: z.array(z.object({ symbol: symbolSchema, ntmEps: finite.positive(), pe: finite.positive() })).min(3).max(8),
  sixMonth: horizonSchema, twelveMonth: horizonSchema,
  confidence: z.enum(["medium", "low"]), assumptions: z.array(z.string()),
  updateReasons: z.array(z.string()),
  revision: z.object({
    previousId: z.string(), previousTarget: finite.positive(), newTarget: finite.positive(), changePct: finite,
    earningsContribution: finite, multipleContribution: finite,
  }).nullable(),
  analyst: analystSchema.nullable(),
}).strict();
export type FundamentalValuation = z.infer<typeof valuationSchema>;

export const stateSchema = z.object({
  version: z.literal(1), symbol: symbolSchema, checkedAt: z.iso.datetime(), nextCheckAt: z.iso.datetime(),
  status: z.enum(["ready", "stale", "unavailable", "pending"]),
  reasons: z.array(z.string()), current: valuationSchema.nullable(),
  latestQuote: z.object({ price: finite.positive(), observedAt: z.iso.datetime() }).nullable(),
  eventIds: z.array(z.string()).max(200), analystStatus: z.enum(["ready", "unavailable", "not-requested"]),
}).strict();
export type FundamentalState = z.infer<typeof stateSchema>;
export type FundamentalPageData = {
  symbol: string; state: FundamentalState | null; history: FundamentalValuation[];
  atEntry: FundamentalValuation | null; entryAt: string | null; error: string | null;
  /** Explicit server-side preview metadata; never part of a valuation or trading input. */
  demo?: boolean;
};

export type FundamentalSummaryData = {
  symbol: string;
  status: FundamentalState["status"] | "missing" | "error";
  reasons: string[];
  checkedAt: string | null;
  publishedAt: string | null;
  method: string | null;
  quote: { price: number; observedAt: string } | null;
  currency: string;
  sixMonth: Pick<FundamentalHorizon, "weightedTarget" | "rangeLow" | "rangeHigh"> | null;
  twelveMonth: Pick<FundamentalHorizon, "weightedTarget" | "rangeLow" | "rangeHigh"> | null;
  demo?: boolean;
};
