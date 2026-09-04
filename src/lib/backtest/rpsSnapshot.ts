import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Timeframe } from "./engine";

/**
 * 每只标的「最后一根」的截面 RPS，构建时算好落成一个小 JSON。
 *
 * 为什么不在请求里现算：RPS 是截面分位，`getPreparedUniverse` 要把全池 195 只
 * 13 年的行情全部载入并重算一遍准备段（MACD 背离链、Vegas 四条 EMA、RSI、
 * 逐日全池排序），冷启动十几秒。TV 的 webhook 等不了，盘后第一条会直接丢。
 *
 * 而这一步的输入是随仓库部署的静态 CSV，最后一根的分位在构建时就定了。
 * 所以构建时算一次，运行时只读文件。
 *
 * 快照按 `sf-broad` 排名。盘中 RPS 本就是日线分位贴上去的，缺档时回落日线。
 */

export const RPS_SNAPSHOT_PATH = path.join(process.cwd(), "data", "rps-latest.json");

export type RpsEntry = {
  rps: number;
  /** 该标的最后一根的日期。面板靠离线抓取，通常落后 TV 几天，要让人看得见。 */
  asOf: string;
};

export type RpsSnapshot = {
  generatedAt: string;
  poolId: string;
  timeframes: Partial<Record<Timeframe, Record<string, RpsEntry>>>;
};

/**
 * 从快照对象里取值。三种结果要能分开：
 * 抛错=快照不可用，null=不在池里或回看未齐，有值=可用。
 */
export function pickRps(
  snapshot: RpsSnapshot | null,
  symbol: string,
  timeframe: Timeframe,
): RpsEntry | null {
  if (!snapshot) {
    throw new Error(
      `RPS 快照缺失：${RPS_SNAPSHOT_PATH}。跑 npm run rps:snapshot 生成（构建时会自动跑）。`,
    );
  }

  const table = snapshot.timeframes[timeframe];
  if (!table) {
    throw new Error(`RPS 快照里没有 ${timeframe} 这一档，生成时该周期的 CSV 可能缺失。`);
  }

  return table[symbol] ?? null;
}

// 文件随部署固定，读到就一直用。缺失不缓存：本地先起 dev 再补生成也能自愈
let cached: RpsSnapshot | null = null;

export function readRpsSnapshot(): RpsSnapshot | null {
  if (cached) return cached;
  if (!existsSync(RPS_SNAPSHOT_PATH)) return null;

  cached = JSON.parse(readFileSync(RPS_SNAPSHOT_PATH, "utf8")) as RpsSnapshot;
  return cached;
}

export function latestRps(symbol: string, timeframe: Timeframe): RpsEntry | null {
  return pickRps(readRpsSnapshot(), symbol, timeframe);
}

/** TV 的 `timeframe.period`：分钟数或 `2H`/`D`/`W` 都认。 */
export function resolveAlertTimeframe(period: string): Timeframe {
  const p = period.trim().toUpperCase();
  if (p === "D" || p === "1D" || p === "W" || p === "M") return "1d";
  if (p === "240" || p === "4H") return "4h";
  if (p === "120" || p === "2H") return "2h";
  if (p === "60" || p === "1H") return "1h";
  const mins = Number(period);
  if (Number.isFinite(mins) && mins > 0) {
    if (mins >= 240) return "4h";
    if (mins >= 120) return "2h";
    if (mins >= 60) return "1h";
  }
  return "1d";
}

/**
 * 告警查分位：先看对应周期，没有那一档就用日线。
 * 票不在快照里返回 null，不抛「不在 Small Fund 池」。
 */
export function lookupAlertRps(symbol: string, timeframe: Timeframe): RpsEntry | null {
  const snapshot = readRpsSnapshot();
  if (!snapshot) {
    throw new Error(
      `RPS 快照缺失：${RPS_SNAPSHOT_PATH}。跑 npm run rps:snapshot 生成（构建时会自动跑）。`,
    );
  }
  const ticker = symbol.includes(":") ? symbol.slice(symbol.lastIndexOf(":") + 1) : symbol;
  const key = ticker.trim().toUpperCase();
  const table = snapshot.timeframes[timeframe] ?? snapshot.timeframes["1d"];
  if (!table) {
    throw new Error(`RPS 快照里没有 ${timeframe} 也没有日线。跑 npm run rps:snapshot。`);
  }
  return table[key] ?? null;
}
