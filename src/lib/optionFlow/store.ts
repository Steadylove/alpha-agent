import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "@/lib/files/atomicJson";
import { deskRemoteUrl, readDeskJson, writeDeskJson } from "@/lib/fund/deskRemote";

import type { OptionFlowPost, OptionFlowStore } from "./types";

export const OPTION_FLOW_FILE = "option-flow.json";

export function emptyOptionFlow(channelId = ""): OptionFlowStore {
  return { updatedAt: "", channelId, lastMessageId: "", posts: [] };
}

export function optionFlowPath(): string {
  if (process.env.OPTION_FLOW_PATH) return process.env.OPTION_FLOW_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", OPTION_FLOW_FILE);
}

function usesRemoteStore(): boolean {
  return !process.env.OPTION_FLOW_PATH && deskRemoteUrl(OPTION_FLOW_FILE) != null;
}

export function optionFlowOf(raw: unknown): OptionFlowStore {
  if (!raw || typeof raw !== "object") return emptyOptionFlow();
  const value = raw as Partial<OptionFlowStore>;
  const posts = Array.isArray(value.posts)
    ? value.posts
        .filter((p) => p && typeof p.id === "string")
        .map((p) => ({ ...p, imageProxyUrls: p.imageProxyUrls ?? [], imageUrls: p.imageUrls ?? [] }))
    : [];
  return {
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    channelId: typeof value.channelId === "string" ? value.channelId : "",
    lastMessageId: typeof value.lastMessageId === "string" ? value.lastMessageId : "",
    posts,
  };
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
    map.set(post.id, { ...post, publishedAt: post.publishedAt ?? prev?.publishedAt });
  }
  const posts = [...map.values()].sort((a, b) => a.postedAt.localeCompare(b.postedAt) || a.id.localeCompare(b.id));
  return {
    updatedAt: now.toISOString(),
    channelId,
    lastMessageId: posts.length ? posts[posts.length - 1].id : previous.lastMessageId,
    posts,
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
