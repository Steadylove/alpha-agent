import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { marketBaseUrl } from "@/lib/backtest/marketStore";

import {
  addSnapshot,
  removeSnapshot,
  snapshotListOf,
  type LookbackSnapshot,
} from "./lookbackSnapshotLogic";

export type { LookbackSnapshot };
export { defaultSnapshotName } from "./lookbackSnapshotLogic";

const REMOTE_FILE = "lookback-snapshots.json";

export function lookbackSnapshotsPath(): string {
  if (process.env.LOOKBACK_SNAPSHOTS_PATH) return process.env.LOOKBACK_SNAPSHOTS_PATH;
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "desk", "lookback-snapshots.json");
}

/** Vercel / 配了行情机时走 VPS；本机未配则仍写本地盘。测试可设 LOOKBACK_SNAPSHOTS_PATH 强制本地。 */
export function lookbackSnapshotsRemoteUrl(): string | null {
  if (process.env.LOOKBACK_SNAPSHOTS_PATH) return null;
  const base = marketBaseUrl();
  return base ? `${base}/desk/${REMOTE_FILE}` : null;
}

function deskSecret(): string {
  return (process.env.DESK_STORE_SECRET || process.env.CRON_SECRET || "").trim();
}

function parseList(raw: string): LookbackSnapshot[] {
  try {
    return snapshotListOf(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function fetchRemote(init?: RequestInit): Promise<Response> {
  const url = lookbackSnapshotsRemoteUrl();
  if (!url) throw new Error("VPS 地址未设");
  const headers = new Headers(init?.headers);
  const secret = deskSecret();
  if (secret && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${secret}`);
  }
  const res = await fetch(url, { cache: "no-store", ...init, headers });
  if (res.status === 404) {
    throw new Error("VPS 还没有 desk 存储，把这版推到 GitHub 才会重装行情服务");
  }
  return res;
}

async function readRemote(): Promise<LookbackSnapshot[]> {
  const res = await fetchRemote();
  if (!res.ok) throw new Error(`VPS 读取失败 HTTP ${res.status}`);
  return parseList(await res.text());
}

async function writeRemote(list: readonly LookbackSnapshot[]): Promise<LookbackSnapshot[]> {
  const res = await fetchRemote({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: `${JSON.stringify(list, null, 2)}\n`,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text.trim() || `VPS 写入失败 HTTP ${res.status}`);
  }
  return [...list];
}

function readLocal(): LookbackSnapshot[] {
  const file = lookbackSnapshotsPath();
  if (!existsSync(file)) return [];
  try {
    return parseList(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function writeLocal(list: readonly LookbackSnapshot[]): LookbackSnapshot[] {
  const file = lookbackSnapshotsPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`);
  return [...list];
}

export async function readLookbackSnapshots(): Promise<LookbackSnapshot[]> {
  if (lookbackSnapshotsRemoteUrl()) return readRemote();
  return readLocal();
}

async function writeAll(list: readonly LookbackSnapshot[]): Promise<LookbackSnapshot[]> {
  if (lookbackSnapshotsRemoteUrl()) return writeRemote(list);
  return writeLocal(list);
}

export async function saveLookbackSnapshot(raw: unknown, now = new Date()): Promise<LookbackSnapshot[]> {
  return writeAll(addSnapshot(await readLookbackSnapshots(), raw, now));
}

export async function deleteLookbackSnapshot(id: string): Promise<LookbackSnapshot[]> {
  return writeAll(removeSnapshot(await readLookbackSnapshots(), id));
}
