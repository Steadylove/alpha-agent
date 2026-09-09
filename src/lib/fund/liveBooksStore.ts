import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { deskRemoteUrl, readDeskJson, writeDeskJson } from "@/lib/fund/deskRemote";
import { liveBookCacheOf, type LiveBookCache } from "@/lib/fund/liveBooksLogic";

const REMOTE_FILE = "live-books.json";

export function liveBooksPath(): string {
  if (process.env.LIVE_BOOKS_PATH) return process.env.LIVE_BOOKS_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", "live-books.json");
}

function useRemote(): boolean {
  return !process.env.LIVE_BOOKS_PATH && deskRemoteUrl(REMOTE_FILE) != null;
}

function readLocal(): LiveBookCache | null {
  const file = liveBooksPath();
  if (!existsSync(file)) return null;
  try {
    return liveBookCacheOf(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

let memory: LiveBookCache | null = null;

function writeLocal(cache: LiveBookCache): void {
  const file = liveBooksPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cache)}\n`);
}

export async function readLiveBooks(): Promise<LiveBookCache | null> {
  if (memory) return memory;
  if (!useRemote()) {
    memory = readLocal();
    return memory;
  }
  try {
    const remote = liveBookCacheOf(await readDeskJson(REMOTE_FILE));
    if (remote) {
      memory = remote;
      return remote;
    }
  } catch {
    // VPS 还没放行这个文件时读本地
  }
  memory = readLocal();
  return memory;
}

export async function writeLiveBooks(cache: LiveBookCache): Promise<void> {
  memory = cache;
  try {
    writeLocal(cache);
  } catch (error) {
    console.error("[live-books] 本地缓存写入失败", liveBooksPath(), error);
  }
  if (!useRemote()) return;
  try {
    await writeDeskJson(REMOTE_FILE, cache);
  } catch (error) {
    console.error("[live-books] VPS 缓存写入失败", error);
  }
}
