/**
 * Discord 信号 + 现金账本共用的交易池。默认 sf-broad，人在网页上加减。
 * 实验室五年窗和 desk 活账本不动。Vercel 只读，改池必须写盘。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PreparedUniverse } from "@/lib/backtest/engine";
import { tickersForPool } from "@/lib/backtest/smallFundPools";

import {
  applySignalPool,
  editSignalPool,
  emptySignalPool,
  isTickerInPool,
  signalPoolOf,
  type SignalPoolPatch,
} from "./signalPoolLogic";

export type { SignalPoolPatch };
export { applySignalPool, editSignalPool, isTickerInPool, normalizeTicker } from "./signalPoolLogic";

export function defaultSignalPoolTickers(): readonly string[] {
  return tickersForPool("sf-broad");
}

export function signalPoolPath(): string {
  if (process.env.SIGNAL_POOL_PATH) return process.env.SIGNAL_POOL_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", "signal-pool.json");
}

export function readSignalPool(): SignalPoolPatch {
  const file = signalPoolPath();
  if (!existsSync(file)) return emptySignalPool();
  try {
    return signalPoolOf(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return emptySignalPool();
  }
}

export function writeSignalPool(patch: SignalPoolPatch, now = new Date()): SignalPoolPatch {
  const next: SignalPoolPatch = { ...patch, updatedAt: now.toISOString() };
  const file = signalPoolPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function readSignalPoolMembers(base: readonly string[] = defaultSignalPoolTickers()): string[] {
  return applySignalPool(base, readSignalPool());
}

export function isInSignalPool(symbol: string): boolean {
  return isTickerInPool(symbol, readSignalPoolMembers());
}

export function clipUniverseToSignalPool(uni: PreparedUniverse): PreparedUniverse {
  const allow = new Set(readSignalPoolMembers());
  return { axis: uni.axis, symbols: uni.symbols.filter((s) => allow.has(s.ticker)) };
}
