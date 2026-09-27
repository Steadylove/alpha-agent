import { describe, expect, it } from "vitest";
import { parseRelayMessage } from "@/lib/optionFlow/parseDiscord";
import { emptyOptionFlow, mergeOptionFlow, optionFlowOf } from "@/lib/optionFlow/store";
import { capturedFlowEvidence, flowEvidenceHash, flowTimestamp, legacyFlowEvidence, mergeFlowEvidence } from "@/lib/optionFlow/provenance";
import { normalizeFlowEvents } from "@/lib/optionFlow/research/events";
import type { OptionFlowPost } from "@/lib/optionFlow/types";

const first = new Date("2026-09-25T14:01:00.000Z"), later = new Date("2026-09-25T15:00:00.000Z");
const message = { id: "123", timestamp: "2026-09-25T14:00:00Z", author: { username: "X-Relay" }, embeds: [{ description: "$AMD - $2M Call buyer", url: "https://x.com/FL0WG0D/status/234", author: { name: "(@FL0WG0D)" } }] };
const parsed = (now = first) => parseRelayMessage(message, now, { channelId: "source" })!;
const legacy = (): OptionFlowPost => {
  const { firstObservedAt: _first, updatedAt: _updated, provenance: _provenance, ...old } = parsed();
  void _first; void _updated; void _provenance;
  return old;
};

describe("option flow evidence availability", () => {
  it("requires a real date and explicit timezone before recording a known clock time", () => {
    expect(flowTimestamp("2026-02-30T12:00:00Z")).toBeNull();
    expect(flowTimestamp("2026-09-25T14:00:00")).toBeNull();
    expect(flowTimestamp("2026-09-25T10:00:00-04:00")).toBe("2026-09-25T14:00:00.000Z");
  });
  it("separates actual collection from relay publication and leaves trade / original post times unknown", () => {
    const post = parsed();
    expect(post.firstObservedAt).toBe(first.toISOString()); expect(post.updatedAt).toBe(first.toISOString());
    expect(post.provenance).toMatchObject({ version: "flow-evidence-v1", revision: 1, relayAt: "2026-09-25T14:00:00.000Z", sourcePublishedAt: null, tradeAt: null, channelId: "source", directionBasis: "source-report", extractionBasis: "text-or-image-unverified" });
    expect(post.provenance!.evidenceHash).toBe(flowEvidenceHash(post));
  });
  it("does not let missing relay timestamps turn the legacy display fallback into known source time", () => {
    const post = parseRelayMessage({ ...message, timestamp: undefined }, first)!;
    expect(post.postedAt).toBe(first.toISOString()); // Existing notification behavior is preserved.
    expect(post.provenance!.relayAt).toBeNull(); expect(post.provenance!.tradeAt).toBeNull();
  });
  it("keeps duplicate captures idempotent and does not confuse outgoing publication with a source revision", () => {
    const saved = mergeOptionFlow(emptyOptionFlow("source"), [parsed()], "source", first);
    const originalHash = saved.posts[0].provenance!.evidenceHash;
    const recaptured = { ...parsed(later), publishedAt: later.toISOString() };
    const next = mergeOptionFlow(saved, [recaptured], "source", later).posts[0];
    expect(next.firstObservedAt).toBe(first.toISOString()); expect(next.updatedAt).toBe(first.toISOString());
    expect(next.provenance).toMatchObject({ evidenceHash: originalHash, revision: 1, revisions: [] });
    expect(next.publishedAt).toBe(later.toISOString());
  });
  it("does not infer first observed or current-version time from an old ingestedAt or postedAt", () => {
    const old = legacyFlowEvidence(legacy());
    expect(old).toMatchObject({ firstObservedAt: null, updatedAt: null });
    expect(old.provenance).toMatchObject({ capture: "legacy", relayAt: null, sourcePublishedAt: null, tradeAt: null });
    const loaded = optionFlowOf({ posts: [legacy()] }).posts[0];
    expect(loaded.firstObservedAt).toBeNull(); expect(loaded.updatedAt).toBeNull();
    const recaptured = mergeFlowEvidence(legacy(), parsed(later), later);
    expect(recaptured.firstObservedAt).toBeNull(); expect(recaptured.updatedAt).toBe(later.toISOString());
    expect(recaptured.provenance!.revisions[0].recordedAt).toBeNull();
  });
  it("stores superseded facts and the time of the new evidence version", () => {
    const old = parsed();
    const incoming = { ...parsed(later), rawText: "$AMD - $3M Call buyer", legs: [{ ...old.legs[0], premiumUsd: 3_000_000 }] };
    const next = mergeFlowEvidence(old, incoming, later);
    expect(next.firstObservedAt).toBe(first.toISOString()); expect(next.updatedAt).toBe(later.toISOString());
    expect(next.provenance!.revision).toBe(2); expect(next.provenance!.evidenceHash).not.toBe(old.provenance!.evidenceHash);
    expect(next.provenance!.revisions[0]).toMatchObject({ revision: 1, recordedAt: first.toISOString(), evidenceHash: old.provenance!.evidenceHash, evidence: { rawText: message.embeds[0].description, legs: [{ ticker: "AMD", premiumUsd: 2_000_000 }] } });
    incoming.legs[0].premiumUsd = 9;
    expect(next.provenance!.revisions[0].evidence.legs[0].premiumUsd).toBe(2_000_000);
  });
  it("captures newly enriched OCR fields in the stored hash without inventing a second observation", () => {
    const raw = parsed(), enriched = { ...raw, legs: [{ ...raw.legs[0], strike: 200, expiry: "10/16/26" }] };
    const stored = mergeFlowEvidence(undefined, enriched, later);
    expect(stored.firstObservedAt).toBe(first.toISOString()); expect(stored.provenance!.revision).toBe(1);
    expect(stored.updatedAt).toBe(later.toISOString()); // Enriched fields cannot become available at the earlier text-parse time.
    expect(stored.provenance!.evidenceHash).toBe(flowEvidenceHash(stored));
    expect(stored.provenance!.evidenceHash).not.toBe(raw.provenance!.evidenceHash);
    expect(stored.provenance!.extractionBasis).toBe("text-or-image-unverified");
  });
  it("retains the initial evidence plus four recent versions with an explicit truncation flag", () => {
    let post = parsed();
    for (let i = 2; i <= 10; i++) post = mergeFlowEvidence(post, { ...parsed(later), rawText: `revision ${i}` }, new Date(later.getTime() + i * 1000));
    expect(post.provenance!.revision).toBe(10); expect(post.provenance!.revisions).toHaveLength(5);
    expect(post.provenance!.revisions.map(row => row.revision)).toEqual([1, 6, 7, 8, 9]);
    expect(post.provenance!.historyTruncated).toBe(true); expect(post.provenance!.revisions[0].evidence.rawText).toBe(message.embeds[0].description);
    expect(post.firstObservedAt).toBe(first.toISOString());
  });
  it("exposes proof to research and leaves historical records explicitly unknown", () => {
    const p = parsed(), copy = capturedFlowEvidence({ ...p, id: "copy", legs: [{ ...p.legs[0], strike: 200 }] }, later, { relayAt: message.timestamp });
    const event = normalizeFlowEvents([p, copy], ["2026-09-25"]).events[0];
    expect(event.firstObservedAt).toBe(first.toISOString()); expect(event.provenance!.tradeAt).toBeNull();
    const old = normalizeFlowEvents([legacy()], ["2026-09-25"]).events[0];
    expect(old.firstObservedAt).toBeNull(); expect(old.updatedAt).toBeNull();
  });
  it.each([undefined, "invalid", [null, 7, { ticker: null }]])("contains malformed leg data at the read boundary: %j", (legs) => {
    const valid = parsed();
    const loaded = optionFlowOf({ posts: [valid, { ...legacy(), id: "broken", legs, imageUrls: 7, imageProxyUrls: [null, "https://example.test/chart.png"] }] });
    expect(loaded.posts).toHaveLength(2);
    expect(loaded.posts[0].provenance).toEqual(valid.provenance);
    expect(loaded.posts[1].legs).toEqual([]);
    expect(loaded.posts[1].imageUrls).toEqual([]);
    expect(loaded.posts[1].imageProxyUrls).toEqual(["https://example.test/chart.png"]);
    expect(loaded.readWarnings).toMatchObject({ rejectedPosts: 0, sanitizedPosts: 1 });
    expect(() => normalizeFlowEvents(loaded.posts, ["2026-09-25"])).not.toThrow();
  });
  it("rejects individual rows without a usable identity/time and retains valid history", () => {
    const loaded = optionFlowOf({ posts: [null, { id: "no-time" }, { ...legacy(), postedAt: "invalid" }, parsed()] });
    expect(loaded.posts).toHaveLength(1); expect(loaded.posts[0].id).toBe("123");
    expect(loaded.readWarnings).toMatchObject({ rejectedPosts: 3, sanitizedPosts: 0 });
  });
  it("does not present a malformed whole document as a clean empty collection", () => {
    for (const raw of [null, [], {}, { posts: "invalid" }]) {
      expect(optionFlowOf(raw).readWarnings?.rejectedPosts).toBe(1);
    }
    expect(optionFlowOf(emptyOptionFlow()).readWarnings).toBeUndefined();
  });
  it("verifies persisted hashes and timestamp order before accepting proof", () => {
    const p = parsed();
    const invalid = [
      { ...p, rawText: "changed outside evidence capture" },
      { ...p, updatedAt: "2026-09-25T13:59:00Z" },
      { ...p, provenance: { ...p.provenance!, revision: 2, revisions: null } },
      { ...p, provenance: { ...p.provenance!, evidenceHash: "bad" } },
    ];
    for (const post of invalid) {
      const loaded = optionFlowOf({ posts: [post] });
      expect(loaded.posts[0].firstObservedAt).toBeNull(); expect(loaded.posts[0].updatedAt).toBeNull();
      expect(loaded.posts[0].provenance).toMatchObject({ capture: "legacy", revision: 1, revisions: [], relayAt: null });
      expect(loaded.readWarnings?.invalidProvenancePosts).toBe(1);
    }
  });
  it("accepts immutable revision snapshots after JSON roundtrip and rejects a tampered snapshot", () => {
    let p = parsed();
    for (let i = 2; i <= 8; i++) p = mergeFlowEvidence(p, { ...parsed(later), rawText: `revision ${i}` }, new Date(later.getTime() + i * 1000));
    const loaded = optionFlowOf(JSON.parse(JSON.stringify({ posts: [p] })));
    expect(loaded.posts[0].provenance).toEqual(p.provenance); expect(loaded.readWarnings).toBeUndefined();
    loaded.posts[0].provenance!.revisions[0].evidence.rawText = "tampered";
    const invalid = optionFlowOf(loaded);
    expect(invalid.posts[0].firstObservedAt).toBeNull(); expect(invalid.posts[0].provenance!.capture).toBe("legacy");
    expect(invalid.readWarnings?.invalidProvenancePosts).toBe(1);
  });
});
