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
};

export type OptionFlowStore = {
  updatedAt: string;
  channelId: string;
  lastMessageId: string;
  posts: OptionFlowPost[];
};

export type OptionFlowConfig = {
  channelId: string;
  minPremiumUsd: number;
  dropAds: boolean;
  dropPaid: boolean;
};
