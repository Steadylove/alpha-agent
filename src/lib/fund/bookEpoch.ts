/**
 * Discord 现金账本的记账起点。实验室五年窗不动，只有推账本读这里。
 *
 * Vercel 只读，重置必须跑在能写盘的机器上（本机或 VPS）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { lastSettledSession } from "@/lib/backtest/mergeBars";
import { SMALL_FUND_FROM } from "@/lib/backtest/smallFundUniverse";

import { bookEpochOf, normalizeBookFrom, type BookEpoch } from "./bookEpochLogic";

export type { BookEpoch };
export { normalizeBookFrom } from "./bookEpochLogic";

export function bookEpochPath(): string {
  if (process.env.BOOK_EPOCH_PATH) return process.env.BOOK_EPOCH_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", "book-epoch.json");
}

export function readBookEpoch(): BookEpoch {
  const file = bookEpochPath();
  if (!existsSync(file)) return { from: SMALL_FUND_FROM, resetAt: "" };
  try {
    return bookEpochOf(JSON.parse(readFileSync(file, "utf8")), SMALL_FUND_FROM);
  } catch {
    return { from: SMALL_FUND_FROM, resetAt: "" };
  }
}

export function resetBookEpoch(from?: string, now = new Date()): BookEpoch {
  const day = normalizeBookFrom(from) ?? lastSettledSession(now);
  const epoch: BookEpoch = { from: day, resetAt: now.toISOString() };
  const file = bookEpochPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(epoch, null, 2)}\n`);
  return epoch;
}
