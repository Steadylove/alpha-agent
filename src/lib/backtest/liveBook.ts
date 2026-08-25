/**
 * 活账本变更的磁盘读写。浏览器不能 import 这个文件。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  extraLiveTickers,
  type LiveBookAction,
  type LiveBookChange,
} from "./liveBookLogic";

export type { LiveBookAction, LiveBookChange };
export { applyLiveBookChanges, extraLiveTickers, inLiveSpan } from "./liveBookLogic";

export function liveBookPath(): string {
  return process.env.LIVE_BOOK_PATH ?? path.join(process.cwd(), "data", "desk", "live-book.json");
}

export function readLiveBook(): LiveBookChange[] {
  const file = liveBookPath();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { changes?: unknown };
    return Array.isArray(raw.changes) ? (raw.changes as LiveBookChange[]) : [];
  } catch {
    return [];
  }
}

function writeLiveBook(changes: LiveBookChange[]): void {
  const file = liveBookPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ changes }, null, 2)}\n`);
}

export function appendLiveBookChange(input: {
  ticker: string;
  action: LiveBookAction;
  date: string;
  reason: string;
}): LiveBookChange {
  const ticker = input.ticker.trim().toUpperCase();
  const date = input.date.trim();
  const reason = input.reason.trim();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(ticker)) {
    throw new Error("标的代码不合法");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("生效日必须是 YYYY-MM-DD");
  }
  if (!reason) throw new Error("必须写理由");

  const row: LiveBookChange = {
    id: `${date}|${input.action}|${ticker}|${Date.now()}`,
    ticker,
    action: input.action,
    date,
    reason,
    at: new Date().toISOString(),
  };
  writeLiveBook([...readLiveBook(), row]);
  return row;
}

export function liveExtraTickers(): string[] {
  return extraLiveTickers(readLiveBook());
}
