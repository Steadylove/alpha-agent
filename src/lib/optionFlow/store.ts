import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "@/lib/files/atomicJson";
import { deskRemoteUrl, readDeskJson, writeDeskJson } from "@/lib/fund/deskRemote";

import type { OptionFlowPost, OptionFlowStore } from "./types";
import { isFlowEvidenceLeg, legacyFlowEvidence, mergeFlowEvidence } from "./provenance";

export const OPTION_FLOW_FILE = "option-flow.json";

export function emptyOptionFlow(channelId = ""): OptionFlowStore {
  return { updatedAt: "", channelId, lastMessageId: "", lastByChannel: {}, posts: [] };
}

export function optionFlowPath(): string {
  if (process.env.OPTION_FLOW_PATH) return process.env.OPTION_FLOW_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", OPTION_FLOW_FILE);
}

function usesRemoteStore(): boolean {
  return !process.env.OPTION_FLOW_PATH && deskRemoteUrl(OPTION_FLOW_FILE) != null;
}

export function optionFlowOf(raw: unknown): OptionFlowStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...emptyOptionFlow(), readWarnings: { rejectedPosts: 1, sanitizedPosts: 0, invalidProvenancePosts: 0 } };
  const value = raw as Partial<OptionFlowStore>;
  const posts: OptionFlowPost[] = [];
  const readWarnings = { rejectedPosts: Array.isArray(value.posts) ? 0 : 1, sanitizedPosts: 0, invalidProvenancePosts: 0 };
  for (const candidate of Array.isArray(value.posts) ? value.posts : []) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || typeof candidate.id !== "string" || !candidate.id || typeof candidate.postedAt !== "string" || !Number.isFinite(Date.parse(candidate.postedAt))) {
      readWarnings.rejectedPosts++; continue;
    }
    const p = candidate as OptionFlowPost;
    const legs = Array.isArray(p.legs) ? p.legs.filter(isFlowEvidenceLeg) : [];
    const imageUrls = Array.isArray(p.imageUrls) ? p.imageUrls.filter(url => typeof url === "string") : [];
    const imageProxyUrls = Array.isArray(p.imageProxyUrls) ? p.imageProxyUrls.filter(url => typeof url === "string") : [];
    const normalized: OptionFlowPost = {
      id: p.id, postedAt: p.postedAt, ingestedAt: typeof p.ingestedAt === "string" ? p.ingestedAt : "",
      kind: ["flow", "noteworthy", "paid", "ad", "gex", "other"].includes(p.kind) ? p.kind : "other",
      thesis: typeof p.thesis === "string" ? p.thesis : "", rawText: typeof p.rawText === "string" ? p.rawText : "",
      legs, imageUrls, imageProxyUrls,
      ...Object.fromEntries(["tweetUrl", "tweetId", "handle", "publishedAt"].filter(key => typeof p[key as keyof OptionFlowPost] === "string").map(key => [key, p[key as keyof OptionFlowPost]])),
      firstObservedAt: p.firstObservedAt, updatedAt: p.updatedAt, provenance: p.provenance,
    };
    if (!Array.isArray(p.legs) || legs.length !== p.legs.length || !Array.isArray(p.imageUrls) || imageUrls.length !== p.imageUrls.length
      || !Array.isArray(p.imageProxyUrls) || imageProxyUrls.length !== p.imageProxyUrls.length
      || normalized.kind !== p.kind || normalized.thesis !== p.thesis || normalized.rawText !== p.rawText || normalized.ingestedAt !== p.ingestedAt) readWarnings.sanitizedPosts++;
    const proven = legacyFlowEvidence(normalized, true);
    if (p.provenance != null && proven.provenance !== p.provenance) readWarnings.invalidProvenancePosts++;
    posts.push(proven);
  }
  return {
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    channelId: typeof value.channelId === "string" ? value.channelId : "",
    lastMessageId: typeof value.lastMessageId === "string" ? value.lastMessageId : "",
    lastByChannel: value.lastByChannel && typeof value.lastByChannel === "object" && !Array.isArray(value.lastByChannel)
      ? Object.fromEntries(Object.entries(value.lastByChannel).filter(([, id]) => typeof id === "string")) : {},
    posts,
    ...(Object.values(readWarnings).some(Boolean) ? { readWarnings } : {}),
  };
}

export function hasPublishedTweet(posts: readonly OptionFlowPost[], tweetId?: string): boolean {
  return Boolean(tweetId && posts.some((post) => post.tweetId === tweetId && post.publishedAt));
}

function readLocal(): OptionFlowStore {
  const file = optionFlowPath();
  if (!existsSync(file)) return emptyOptionFlow();
  return optionFlowOf(JSON.parse(readFileSync(file, "utf8")));
}

export async function readOptionFlow(): Promise<OptionFlowStore> {
  if (!usesRemoteStore()) return readLocal();
  try {
    return optionFlowOf(await readDeskJson(OPTION_FLOW_FILE));
  } catch {
    return readLocal();
  }
}

export function mergeOptionFlow(previous: OptionFlowStore, incoming: OptionFlowPost[], channelId: string, now = new Date()): OptionFlowStore {
  const map = new Map(previous.posts.map((post) => [post.id, post]));
  for (const post of incoming) {
    const prev = map.get(post.id);
    map.set(post.id, { ...mergeFlowEvidence(prev, post, now), publishedAt: post.publishedAt ?? prev?.publishedAt });
  }
  const posts = [...map.values()].sort((a, b) => a.postedAt.localeCompare(b.postedAt) || a.id.localeCompare(b.id));
  const sameChannel = !previous.channelId || previous.channelId === channelId;
  return {
    updatedAt: now.toISOString(),
    channelId: previous.channelId || channelId,
    lastMessageId: sameChannel && incoming.length ? incoming[incoming.length - 1].id : previous.lastMessageId,
    lastByChannel: previous.lastByChannel ?? {},
    posts,
  };
}

export function withChannelCursor(store: OptionFlowStore, channelId: string, lastId: string): OptionFlowStore {
  const lastByChannel = { ...store.lastByChannel, [channelId]: lastId };
  return {
    ...store,
    lastByChannel,
    lastMessageId: !store.channelId || store.channelId === channelId ? lastId : store.lastMessageId,
  };
}

export async function writeOptionFlow(store: OptionFlowStore): Promise<OptionFlowStore> {
  writeJsonAtomic(optionFlowPath(), store);
  if (!usesRemoteStore()) return store;
  try {
    await writeDeskJson(OPTION_FLOW_FILE, store);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[option-flow] VPS 写入失败，已留在本地 ${optionFlowPath()}：${reason}`);
  }
  return store;
}
