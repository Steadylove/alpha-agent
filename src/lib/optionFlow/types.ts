export type OptionRight = "call" | "put";

export type OptionFlowKind = "flow" | "noteworthy" | "paid" | "ad" | "gex" | "other";

export type OptionFlowLeg = {
  ticker: string;
  right?: OptionRight;
  strike?: number;
  expiry?: string;
  premiumUsd?: number;
  optionPrice?: number;
  otmPct?: number;
  note?: string;
};

/** Frozen source evidence; deliberately excludes our outgoing publication marker. */
export type FlowEvidencePayload = {
  id: string;
  postedAt: string;
  tweetUrl: string | null;
  tweetId: string | null;
  handle: string | null;
  kind: OptionFlowKind;
  thesis: string;
  rawText: string;
  legs: OptionFlowLeg[];
  imageUrls: string[];
  imageProxyUrls: string[];
  sourcePublishedAt: string | null;
  relayAt: string | null;
  tradeAt: string | null;
};
export type FlowEvidenceRevision = {
  revision: number;
  evidenceHash: string;
  recordedAt: string | null;
  evidence: FlowEvidencePayload;
};
export type FlowProvenance = {
  version: "flow-evidence-v1";
  evidenceHash: string;
  revision: number;
  sourcePublishedAt: string | null;
  relayAt: string | null;
  tradeAt: string | null;
  channelId: string | null;
  capture: "live" | "backfill" | "legacy";
  directionBasis: "source-report";
  extractionBasis: "text-or-image-unverified";
  /** First evidence plus the four most recent superseded versions, at most five. */
  revisions: FlowEvidenceRevision[];
  historyTruncated: boolean;
};

export type OptionFlowPost = {
  id: string;
  postedAt: string;
  ingestedAt: string;
  tweetUrl?: string;
  tweetId?: string;
  handle?: string;
  kind: OptionFlowKind;
  thesis: string;
  legs: OptionFlowLeg[];
  imageUrls: string[];
  imageProxyUrls: string[];
  rawText: string;
  publishedAt?: string;
  /** Null for legacy records whose first capture cannot be proved. Never inferred from postedAt. */
  firstObservedAt?: string | null;
  /** Availability time of this evidence version, not the latest polling heartbeat. */
  updatedAt?: string | null;
  provenance?: FlowProvenance;
};

export type OptionFlowStore = {
  updatedAt: string;
  channelId: string;
  lastMessageId: string;
  lastByChannel?: Record<string, string>;
  posts: OptionFlowPost[];
  /** Read-time integrity issues; consumers must not interpret incomplete evidence as no activity. */
  readWarnings?: { rejectedPosts: number; sanitizedPosts: number; invalidProvenancePosts: number };
};

export type OptionFlowConfig = {
  channelId: string;
  minPremiumUsd: number;
  dropAds: boolean;
  dropPaid: boolean;
};
