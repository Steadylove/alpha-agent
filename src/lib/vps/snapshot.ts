/**
 * 看板快照落在 VPS 行情目录的 snapshots/，跟 CSV 一起 rsync。
 * 本地有 MARKET_DATA_DIR 读本地；线上走 MARKET_DATA_BASE_URL。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { marketBaseUrl, marketDataRoot } from "@/lib/backtest/marketStore";
import { writeJsonAtomic } from "@/lib/files/atomicJson";

export function snapshotDir(): string {
  const root = marketDataRoot();
  if (root) return path.join(root, "snapshots");
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "snapshots");
}

export function snapshotFile(name: string): string {
  return path.join(snapshotDir(), `${name}.json`);
}

export function writeSnapshot(name: string, value: unknown): void {
  writeJsonAtomic(snapshotFile(name), value);
}

export async function readSnapshot<T>(name: string, signal?: AbortSignal): Promise<T | null> {
  if (marketBaseUrl()) {
    const text = await fetchMarketText(`snapshots/${name}.json`, signal);
    if (text.trim()) {
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    }
  }
  const file = snapshotFile(name);
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  }
  return null;
}
