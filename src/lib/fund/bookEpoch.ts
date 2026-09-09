/**
 * Discord 现金账本的记账起点。实验室五年窗不动，只有推账本读这里。
 *
 * Vercel 写 VPS desk；本机未配行情机则写本地盘。
 */

import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import path from "node:path";

import { lastSettledSession } from "@/lib/backtest/mergeBars";
import { SMALL_FUND_FROM } from "@/lib/backtest/smallFundUniverse";

import { bookEpochOf, normalizeBookFrom, type BookEpoch } from "./bookEpochLogic";
import { deskRemoteUrl, readDeskJson, writeDeskJson } from "./deskRemote";

export type { BookEpoch };
export { normalizeBookFrom } from "./bookEpochLogic";

const REMOTE_FILE = "book-epoch.json";

export function bookEpochPath(): string {
  if (process.env.BOOK_EPOCH_PATH) return process.env.BOOK_EPOCH_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", "book-epoch.json");
}

function usesRemoteStore(): boolean {
  return !process.env.BOOK_EPOCH_PATH && deskRemoteUrl(REMOTE_FILE) != null;
}

function readLocal(): BookEpoch {
  const file = bookEpochPath();
  if (!existsSync(file)) return { from: SMALL_FUND_FROM, resetAt: "" };
  return bookEpochOf(JSON.parse(readFileSync(file, "utf8")), SMALL_FUND_FROM);
}

function writeLocal(epoch: BookEpoch): BookEpoch {
  const file = bookEpochPath();
  writeJsonAtomic(file, epoch);
  return epoch;
}

export async function readBookEpoch(): Promise<BookEpoch> {
  if (!usesRemoteStore()) return readLocal();
  return bookEpochOf(await readDeskJson(REMOTE_FILE), SMALL_FUND_FROM);
}

export async function resetBookEpoch(from?: string, now = new Date()): Promise<BookEpoch> {
  const day = normalizeBookFrom(from) ?? lastSettledSession(now);
  const epoch: BookEpoch = { from: day, resetAt: now.toISOString() };
  if (!usesRemoteStore()) return writeLocal(epoch);
  await writeDeskJson(REMOTE_FILE, epoch);
  return epoch;
}
