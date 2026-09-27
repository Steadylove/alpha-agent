import { createHash } from "node:crypto";
import type { FlowEvidencePayload, FlowEvidenceRevision, FlowProvenance, OptionFlowLeg, OptionFlowPost } from "./types";

export const FLOW_EVIDENCE_VERSION = "flow-evidence-v1" as const;
const HISTORY_LIMIT = 5;
const HASH = /^[a-f0-9]{64}$/;
const KINDS = new Set(["flow", "noteworthy", "paid", "ad", "gex", "other"]);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function optionalString(value: unknown): boolean { return value === undefined || typeof value === "string"; }
function nullableString(value: unknown): boolean { return value === null || typeof value === "string"; }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
export function isFlowEvidenceLeg(value: unknown): value is OptionFlowLeg {
  return record(value) && typeof value.ticker === "string" && value.ticker.length > 0
    && (value.right === undefined || value.right === "call" || value.right === "put")
    && ["strike", "premiumUsd", "optionPrice", "otmPct"].every(key => value[key] === undefined || typeof value[key] === "number" && Number.isFinite(value[key]))
    && ["expiry", "note"].every(key => optionalString(value[key]));
}
function validPayload(value: unknown): value is FlowEvidencePayload {
  return record(value) && ["id", "postedAt", "thesis", "rawText"].every(key => typeof value[key] === "string")
    && KINDS.has(String(value.kind)) && ["tweetUrl", "tweetId", "handle"].every(key => nullableString(value[key]))
    && Array.isArray(value.legs) && value.legs.every(isFlowEvidenceLeg) && stringArray(value.imageUrls) && stringArray(value.imageProxyUrls)
    && ["sourcePublishedAt", "relayAt", "tradeAt"].every(key => value[key] === null || flowTimestamp(value[key]) !== null);
}
export function flowTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const day = value.slice(0, 10), midnight = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function metadata(post: OptionFlowPost): Pick<FlowProvenance, "sourcePublishedAt" | "relayAt" | "tradeAt"> {
  const provenance = post.provenance?.version === FLOW_EVIDENCE_VERSION ? post.provenance : null;
  return { sourcePublishedAt: flowTimestamp(provenance?.sourcePublishedAt), relayAt: flowTimestamp(provenance?.relayAt), tradeAt: flowTimestamp(provenance?.tradeAt) };
}
export function flowEvidencePayload(post: OptionFlowPost): FlowEvidencePayload {
  return {
    id: post.id, postedAt: post.postedAt, tweetUrl: post.tweetUrl ?? null, tweetId: post.tweetId ?? null, handle: post.handle ?? null,
    kind: post.kind, thesis: post.thesis, rawText: post.rawText,
    legs: (post.legs ?? []).map(leg => ({ ticker: leg.ticker, right: leg.right, strike: leg.strike, expiry: leg.expiry, premiumUsd: leg.premiumUsd, optionPrice: leg.optionPrice, otmPct: leg.otmPct, note: leg.note })),
    imageUrls: [...(post.imageUrls ?? [])], imageProxyUrls: [...(post.imageProxyUrls ?? [])], ...metadata(post),
  };
}
export function flowEvidenceHash(post: OptionFlowPost): string {
  return createHash("sha256").update(JSON.stringify(flowEvidencePayload(post))).digest("hex");
}
function validProvenance(post: OptionFlowPost, verifyStoredHash: boolean): boolean {
  const p = post.provenance;
  if (!p || p.version !== FLOW_EVIDENCE_VERSION || !HASH.test(p.evidenceHash) || !Number.isSafeInteger(p.revision) || p.revision < 1
    || !["live", "backfill", "legacy"].includes(p.capture) || !nullableString(p.channelId)
    || p.directionBasis !== "source-report" || p.extractionBasis !== "text-or-image-unverified"
    || typeof p.historyTruncated !== "boolean" || !Array.isArray(p.revisions) || p.revisions.length !== Math.min(p.revision - 1, HISTORY_LIMIT)
    || p.historyTruncated !== (p.revision > HISTORY_LIMIT + 1)
    || ![p.sourcePublishedAt, p.relayAt, p.tradeAt].every(at => at === null || flowTimestamp(at) !== null)) return false;
  const first = flowTimestamp(post.firstObservedAt), updated = flowTimestamp(post.updatedAt);
  if ((post.firstObservedAt !== null && !first) || (post.updatedAt !== null && !updated)
    || (p.capture !== "legacy" && (!first || !updated)) || (p.capture === "legacy" && first !== null)
    || (first && updated && updated < first) || (p.revision > 1 && !updated)) return false;
  let priorRevision = 0, priorTime: string | null = null;
  for (const row of p.revisions) {
    if (!record(row) || !Number.isSafeInteger(row.revision) || row.revision <= priorRevision || row.revision >= p.revision
      || !HASH.test(row.evidenceHash) || !validPayload(row.evidence)
      || row.evidence.id !== post.id || (row.recordedAt !== null && !flowTimestamp(row.recordedAt))) return false;
    const at = flowTimestamp(row.recordedAt);
    if ((at && updated && at > updated) || (at && first && at < first) || (at && priorTime && at < priorTime)) return false;
    if (createHash("sha256").update(JSON.stringify(row.evidence)).digest("hex") !== row.evidenceHash) return false;
    priorRevision = row.revision; priorTime = at ?? priorTime;
  }
  if (p.revisions.length && (p.revisions[0].revision !== 1 || p.revisions.at(-1)!.revision !== p.revision - 1)) return false;
  return !verifyStoredHash || flowEvidenceHash(post) === p.evidenceHash;
}
function baseProvenance(post: OptionFlowPost, options: { relayAt?: string | null; channelId?: string | null; capture: FlowProvenance["capture"] }): FlowProvenance {
  const provenance: FlowProvenance = {
    version: FLOW_EVIDENCE_VERSION, evidenceHash: "", revision: 1, sourcePublishedAt: null,
    relayAt: flowTimestamp(options.relayAt), tradeAt: null, channelId: options.channelId ?? null, capture: options.capture,
    directionBasis: "source-report", extractionBasis: "text-or-image-unverified", revisions: [], historyTruncated: false,
  };
  provenance.evidenceHash = flowEvidenceHash({ ...post, provenance });
  return provenance;
}
/** Called only at a new real collection. An old store row must use legacyFlowEvidence instead. */
export function capturedFlowEvidence(post: OptionFlowPost, now: Date, options: { relayAt?: string | null; channelId?: string | null; capture?: "live" | "backfill" } = {}): OptionFlowPost {
  const at = now.toISOString();
  return { ...post, firstObservedAt: at, updatedAt: at, provenance: baseProvenance(post, { ...options, capture: options.capture ?? "live" }) };
}
/** Unknown historical availability stays unknown, even when ingestedAt happens to look valid. */
export function legacyFlowEvidence(post: OptionFlowPost, verifyStoredHash = false): OptionFlowPost {
  if (validProvenance(post, verifyStoredHash)) return post;
  return { ...post, firstObservedAt: null, updatedAt: null, provenance: baseProvenance(post, { capture: "legacy" }) };
}
function snapshot(post: OptionFlowPost): FlowEvidenceRevision {
  return { revision: post.provenance!.revision, evidenceHash: post.provenance!.evidenceHash, recordedAt: flowTimestamp(post.updatedAt), evidence: flowEvidencePayload(post) };
}

/** Keep first availability immutable; OCR/text changes create a separately timed version. */
export function mergeFlowEvidence(previous: OptionFlowPost | undefined, incoming: OptionFlowPost, now: Date): OptionFlowPost {
  const next = legacyFlowEvidence(incoming);
  // OCR may have enriched the newly parsed record before it reached persistence.
  const hash = flowEvidenceHash(next);
  if (!previous) return { ...next, updatedAt: next.provenance!.capture === "legacy" ? null : now.toISOString(), provenance: { ...next.provenance!, evidenceHash: hash } };
  const before = legacyFlowEvidence(previous, true), old = before.provenance!;
  const firstObservedAt = flowTimestamp(before.firstObservedAt);
  if (hash === old.evidenceHash) {
    return { ...next, firstObservedAt, updatedAt: before.updatedAt ?? null, provenance: { ...old, channelId: old.channelId ?? next.provenance?.channelId ?? null } };
  }
  const history = [...old.revisions, snapshot(before)];
  const retained = history.length <= HISTORY_LIMIT ? history : [history[0], ...history.slice(-(HISTORY_LIMIT - 1))];
  return {
    ...next, firstObservedAt, updatedAt: now.toISOString(),
    provenance: { ...next.provenance!, evidenceHash: hash, revision: old.revision + 1, channelId: old.channelId ?? next.provenance?.channelId ?? null,
      capture: old.capture, revisions: retained, historyTruncated: old.historyTruncated || history.length > HISTORY_LIMIT },
  };
}
