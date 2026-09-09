/**
 * 行情落盘的根目录与打包布局。
 *
 * 不设 MARKET_DATA_DIR 时沿用仓库里的 data/smallfund*。
 * 设了就用规范布局：1d / 4h / 2h / 1h / rps，方便整目录打包搬走。
 */

import { existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "@/lib/files/atomicJson";

export const MARKET_TIMEFRAMES = ["1d", "4h", "2h", "1h"] as const;
export type MarketTimeframe = (typeof MARKET_TIMEFRAMES)[number];

const FALLBACK_DIR: Record<MarketTimeframe, string> = {
  "1d": "smallfund",
  "4h": "smallfund4h",
  "2h": "smallfund2h",
  "1h": "smallfund1h",
};

export function marketDataRoot(): string | null {
  const raw = process.env.MARKET_DATA_DIR?.trim();
  return raw ? path.resolve(raw) : null;
}

const DEFAULT_MARKET_URL = "http://108.174.50.53:8787";

/** Vercel 读 VPS 静态行情。未设时生产默认指这台机。 */
export function marketBaseUrl(): string | null {
  const raw = process.env.MARKET_DATA_BASE_URL?.trim();
  if (raw) return raw.replace(/\/$/, "");
  if (process.env.VERCEL) return DEFAULT_MARKET_URL;
  return null;
}

export function csvDir(timeframe: MarketTimeframe): string {
  const root = marketDataRoot();
  if (root) return path.join(root, timeframe);
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data", FALLBACK_DIR[timeframe]);
}

export function rpsDir(): string {
  const root = marketDataRoot();
  if (root) return path.join(root, "rps");
  return path.join(/*turbopackIgnore: true*/ process.cwd(), "data");
}

export function rpsScaleFile(): string {
  return path.join(rpsDir(), "rps-scale-spx.json");
}

export function rpsSnapshotFile(): string {
  return path.join(rpsDir(), "rps-latest.json");
}

export type MarketManifest = {
  generatedAt: string;
  root: string;
  timeframes: Record<string, { files: number; bytes: number; asOf?: string }>;
  rps: { scale: boolean; snapshot: boolean };
};

function dirStats(dir: string): { files: number; bytes: number; asOf?: string } {
  if (!existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  let asOf = "";
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".csv")) continue;
    files += 1;
    const file = path.join(dir, name);
    const size = statSync(file).size;
    bytes += size;
    const fd = openSync(file, "r");
    try {
      const tail = Buffer.alloc(Math.min(2048, size));
      readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
      const date = tail.toString("utf8").trim().split(/\r?\n/).at(-1)?.split(",")[0] ?? "";
      if (/^\d{4}-\d{2}-\d{2}/.test(date) && date > asOf) asOf = date;
    } finally { closeSync(fd); }
  }
  return { files, bytes, asOf: asOf || undefined };
}

export function buildManifest(root: string): MarketManifest {
  const timeframes: MarketManifest["timeframes"] = {};
  for (const tf of MARKET_TIMEFRAMES) {
    timeframes[tf] = dirStats(path.join(root, tf));
  }
  return {
    generatedAt: new Date().toISOString(),
    root,
    timeframes,
    rps: {
      scale: existsSync(path.join(root, "rps", "rps-scale-spx.json")),
      snapshot: existsSync(path.join(root, "rps", "rps-latest.json")),
    },
  };
}

export function writeManifest(root: string): MarketManifest {
  mkdirSync(root, { recursive: true });
  const manifest = buildManifest(root);
  writeJsonAtomic(path.join(root, "MANIFEST.json"), manifest);
  return manifest;
}

/** 仓库默认目录 → 规范布局的对照，打包时按这个组装。 */
export function localSourceLayout(): { dest: string; src: string }[] {
  return [
    ...MARKET_TIMEFRAMES.map((tf) => ({ dest: tf, src: csvDir(tf) })),
    { dest: path.join("rps", "rps-scale-spx.json"), src: rpsScaleFile() },
    { dest: path.join("rps", "rps-latest.json"), src: rpsSnapshotFile() },
  ];
}
