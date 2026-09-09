import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { deskRemoteUrl, readDeskJson, writeDeskJson } from "./deskRemote";
import { liveBookCacheOf, liveBookVersion, type LiveBookCache, type LiveBookVersion } from "./liveBooksLogic";
import { writeJsonAtomic } from "@/lib/files/atomicJson";

const REMOTE_FILE = "live-books.json";
export const isBookVersionId = (id: string): boolean => /^[a-zA-Z0-9-]{1,80}$/.test(id);

export function liveBooksPath(): string {
  return process.env.LIVE_BOOKS_PATH || path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", REMOTE_FILE);
}

function usesRemoteStore(): boolean {
  return !process.env.LIVE_BOOKS_PATH && deskRemoteUrl(REMOTE_FILE) != null;
}

function parse(raw: unknown): LiveBookCache | null {
  // VPS 尚未首次计算时返回 {}，与损坏的已有结果区别处理。
  if (raw == null || (typeof raw === "object" && Object.keys(raw).length === 0)) return null;
  const cache = liveBookCacheOf(raw);
  if (!cache) throw new Error("账本文件无效，请检查存储或重新计算");
  return cache;
}

function readLocal(file = liveBooksPath()): LiveBookCache | null {
  if (!existsSync(file)) return null;
  return parse(JSON.parse(readFileSync(file, "utf8")));
}

export function bookVersionId(cache: LiveBookCache): string {
  return cache.runId || `legacy-${createHash("sha256").update(JSON.stringify([cache.computedAt, cache.epochFrom, cache.poolKey, cache.slots])).digest("hex").slice(0, 32)}`;
}

function versionPath(id: string): string {
  if (!isBookVersionId(id)) throw new Error("账本版本号无效");
  return path.join(path.dirname(liveBooksPath()), "book-versions", `${id}.json`);
}

function archive(cache: LiveBookCache): void {
  cache = liveBookCacheOf(cache)!;
  const file = versionPath(bookVersionId(cache));
  if (existsSync(file)) {
    if (JSON.stringify(readLocal(file)) !== JSON.stringify(cache)) throw new Error("账本版本已存在，不能覆盖历史结果");
    return;
  }
  writeJsonAtomic(file, cache);
}

/** 每次读取持久化结果，不用跨请求的内存缓存，也不把远程失败伪装成本地旧数据。 */
export async function readLiveBooks(): Promise<LiveBookCache | null> {
  return usesRemoteStore() ? parse(await readDeskJson(REMOTE_FILE)) : readLocal();
}

/** 历史归档完成后才原子替换当前结果；任何失败都向调用者报告。 */
export async function writeLiveBooks(cache: LiveBookCache): Promise<void> {
  if (usesRemoteStore()) {
    await writeDeskJson(REMOTE_FILE, cache);
    return;
  }
  const previous = readLocal();
  if (previous) archive(previous);
  archive(cache);
  writeJsonAtomic(liveBooksPath(), cache);
}

export async function readLiveBookVersion(id: string): Promise<LiveBookCache | null> {
  if (!isBookVersionId(id)) throw new Error("账本版本号无效");
  if (usesRemoteStore()) return parse(await readDeskJson(`book-versions/${id}.json`));
  const archived = readLocal(versionPath(id));
  if (archived) return archived;
  const current = readLocal();
  return current && bookVersionId(current) === id ? current : null;
}

export async function listLiveBookVersions(): Promise<LiveBookVersion[]> {
  if (usesRemoteStore()) {
    const raw = await readDeskJson("live-books-history.json");
    if (!Array.isArray(raw)) throw new Error("账本历史列表无效");
    return raw as LiveBookVersion[];
  }
  const dir = path.join(path.dirname(liveBooksPath()), "book-versions");
  const versions = new Map<string, LiveBookVersion>();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      const cache = readLocal(versionPath(id));
      if (cache) versions.set(id, liveBookVersion(cache, id));
    }
  }
  const current = await readLiveBooks();
  if (current) {
    const id = bookVersionId(current);
    versions.set(id, liveBookVersion(current, id));
  }
  return [...versions.values()].sort((a, b) => b.computedAt.localeCompare(a.computedAt));
}
