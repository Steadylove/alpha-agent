/**
 * 现金账本用的交易池。默认 sf-broad，人在网页上加减。
 * Discord 转发不看这份名单，只过 RPS。实验室五年窗和 desk 活账本不动。
 * Vercel 写 VPS desk；本机未配行情机则写本地盘。
 */

import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { PreparedUniverse } from "@/lib/backtest/engine";
import { tickersForPool } from "@/lib/backtest/smallFundPools";

import { deskRemoteUrl, readDeskJson, writeDeskJson } from "./deskRemote";
import {
  applySignalPool,
  emptySignalPool,
  isTickerInPool,
  signalPoolOf,
  type SignalPoolPatch,
} from "./signalPoolLogic";

export type { SignalPoolPatch };
export {
  applySignalPool,
  baseOfPool,
  editSignalPool,
  editSignalPoolMany,
  isTickerInPool,
  normalizeTicker,
  parseTickers,
  replaceSignalPool,
  tickerListOf,
} from "./signalPoolLogic";

const REMOTE_FILE = "signal-pool.json";

export function defaultSignalPoolTickers(): readonly string[] {
  return tickersForPool("sf-broad");
}

export function signalPoolPath(): string {
  if (process.env.SIGNAL_POOL_PATH) return process.env.SIGNAL_POOL_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", "signal-pool.json");
}

function usesRemoteStore(): boolean {
  return !process.env.SIGNAL_POOL_PATH && deskRemoteUrl(REMOTE_FILE) != null;
}

function readLocal(): SignalPoolPatch {
  const file = signalPoolPath();
  if (!existsSync(file)) return emptySignalPool();
  return signalPoolOf(JSON.parse(readFileSync(file, "utf8")));
}

function writeLocal(patch: SignalPoolPatch): SignalPoolPatch {
  const file = signalPoolPath();
  writeJsonAtomic(file, patch);
  return patch;
}

export async function readSignalPool(): Promise<SignalPoolPatch> {
  if (!usesRemoteStore()) return readLocal();
  return signalPoolOf(await readDeskJson(REMOTE_FILE));
}

export async function writeSignalPool(patch: SignalPoolPatch, now = new Date()): Promise<SignalPoolPatch> {
  const remote = usesRemoteStore();
  const previous = remote ? await readSignalPool() : readLocal();
  const base = defaultSignalPoolTickers();
  const before = applySignalPool(base, previous);
  const members = applySignalPool(base, patch);
  if (JSON.stringify(before) === JSON.stringify(members)) return previous;
  const at = now.toISOString();
  if (previous.updatedAt && Date.parse(at) < Date.parse(previous.updatedAt)) throw new Error("保存时间早于现有版本，请校准服务器时间");
  const next: SignalPoolPatch = {
    ...patch, members, updatedAt: at,
    revisions: [
      ...(previous.revisions ?? [{ id: "baseline", effectiveAt: "", members: before }]),
      { id: randomUUID(), effectiveAt: at, members },
    ],
  };
  if (!remote) return writeLocal(next);
  await writeDeskJson(REMOTE_FILE, next, previous.updatedAt);
  return next;
}

export async function readSignalPoolMembers(
  base: readonly string[] = defaultSignalPoolTickers(),
): Promise<string[]> {
  return applySignalPool(base, await readSignalPool());
}

export async function isInSignalPool(symbol: string): Promise<boolean> {
  return isTickerInPool(symbol, await readSignalPoolMembers());
}

export async function clipUniverseToSignalPool(
  uni: PreparedUniverse,
  members?: readonly string[],
): Promise<PreparedUniverse> {
  const allow = new Set(members ?? (await readSignalPoolMembers()));
  return { axis: uni.axis, symbols: uni.symbols.filter((s) => allow.has(s.ticker)) };
}
