/**
 * 网页与日推现金账本的分周期记账起点，实验室五年窗不动。
 *
 * Vercel 写 VPS desk；本机未配行情机则写本地盘。
 */

import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import path from "node:path";

import { lastSettledSession } from "@/lib/backtest/mergeBars";
import { SMALL_FUND_FROM } from "@/lib/backtest/smallFundUniverse";

import { bookEpochStateOf, normalizeBookFrom, type BookEpoch, type BookEpochState } from "./bookEpochLogic";
import { isLookbackTf, type LookbackTf } from "./lookbackLogic";
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

function readLocal(): BookEpochState {
  const file = bookEpochPath();
  return bookEpochStateOf(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null, SMALL_FUND_FROM);
}

function writeLocal(epoch: BookEpochState): void {
  const file = bookEpochPath();
  writeJsonAtomic(file, epoch);
}

export async function readBookEpoch(): Promise<BookEpochState> {
  if (!usesRemoteStore()) return readLocal();
  return bookEpochStateOf(await readDeskJson(REMOTE_FILE), SMALL_FUND_FROM);
}

export async function resetBookEpoch(tf: LookbackTf, from: string, now = new Date()): Promise<BookEpoch> {
  if (!isLookbackTf(tf)) throw new Error("请选择 2H 或 4H 账本");
  const day = normalizeBookFrom(from);
  if (!day || day > lastSettledSession(now)) throw new Error("请选择有效日期，且不能晚于最近已收盘交易日");
  const remote = usesRemoteStore();
  const previous = remote ? await readBookEpoch() : readLocal();
  const at = new Date(Math.max(now.getTime(), (Date.parse(previous.updatedAt) || 0) + 1,
    (Date.parse(previous.epochs[tf].resetAt) || 0) + 1)).toISOString();
  const epoch: BookEpoch = { from: day, resetAt: at };
  const epochs = { ...previous.epochs, [tf]: epoch };
  const next: BookEpochState = { ...epochs["4h"], epochs, updatedAt: at };
  if (remote) await writeDeskJson(REMOTE_FILE, next, previous.updatedAt);
  else writeLocal(next);
  return epoch;
}
