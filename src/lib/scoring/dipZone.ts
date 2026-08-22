/**
 * 机构 VWAP 与 Vegas 隧道低吸支撑带。
 *
 * 对齐「MarketCompass」Pine 第 580~630 行。每个形态阶段对应一套不同的
 * 支撑锚点，越弱的阶段越往下沉、缓冲越厚。
 *
 * 注意 Pine 里的 `current_atr` 不是 ATR14 本身，而是 `sma(atr(14), 252)`，
 * 即一年平均的 ATR，因此这条带子不会随最近几天的波动大幅漂移。
 */

import type { StockStage } from "./stockStage";

export type DipZoneQuality = "prime" | "dry_up" | "normal" | "bottom" | "choppy";

export type DipZone =
  /** 大盘 Path 4，低吸冻结 */
  | { kind: "frozen" }
  /** Stage C，已远离成本线，安全垫失效 */
  | { kind: "overextended" }
  /** Stage D，趋势衰减，只标出上方压制的成本线 */
  | { kind: "avoid"; resistance: number }
  | { kind: "range"; low: number; high: number; quality: DipZoneQuality };

export interface DipZoneInput {
  close: number;
  /** sma(atr(14), 252)，长周期平均真实波幅 */
  atr: number;
  /** 必须传 `dipStageOf(flags)` 的结果，而非展示阶段——两套优先级不同 */
  stage: StockStage;
  trendScore: number;
  /** 当日量 / 50 日均量 */
  volumeRatio: number;
  /** MPR 路径，4 时冻结低吸 */
  pathId: number;
  ema20: number | null;
  ema50: number | null;
  ema576: number | null;
  vwap90: number | null;
  vwap250: number | null;
  ema144: number | null;
  ema169: number | null;
}

export function computeDipZone(input: DipZoneInput): DipZone {
  const { close, atr, stage, trendScore, volumeRatio, pathId } = input;

  if (pathId === 4) return { kind: "frozen" };

  // Pine 的 nz(x, close)：预热期缺失的均线一律用当日收盘价顶替
  const ema20 = input.ema20 ?? close;
  const ema50 = input.ema50 ?? close;
  const ema576 = input.ema576 ?? close;
  const ema144 = input.ema144 ?? close;
  const ema169 = input.ema169 ?? close;
  const vwap90 = input.vwap90 ?? close;
  const vwap250 = input.vwap250 ?? close;

  const vegasTop = Math.max(ema144, ema169);
  const vegasBot = Math.min(ema144, ema169);

  const deepBuffer = 1.0 * atr;
  const shallowBuffer = 0.3 * atr;

  switch (stage) {
    case "A": {
      const base = Math.min(close, Math.max(ema20, vwap90));
      const high = Math.min(close, base + shallowBuffer);
      const low = Math.min(high * 0.98, base - deepBuffer);
      return { kind: "range", low, high, quality: "prime" };
    }

    case "B": {
      if (trendScore >= 7) {
        const base = Math.min(close, Math.max(ema50, vegasBot));
        const high = Math.min(close, ema20);
        const low = Math.min(high * 0.97, base - 1.2 * atr);
        return { kind: "range", low, high, quality: volumeRatio < 0.5 ? "dry_up" : "prime" };
      }
      const base = Math.min(close, Math.max(vwap90, vegasBot));
      const high = Math.min(close, Math.min(ema50, vegasTop));
      const low = Math.min(high * 0.97, base - 1.0 * atr);
      return { kind: "range", low, high, quality: "normal" };
    }

    case "E": {
      const base = Math.min(close, Math.min(vwap90, vegasTop));
      const high = Math.min(close, base);
      const low = Math.min(high * 0.92, Math.max(ema576, vwap250 * 0.9) - 1.5 * atr);
      return { kind: "range", low, high, quality: "bottom" };
    }

    case "W":
      return {
        kind: "range",
        low: close - 1.5 * atr,
        high: close - 0.2 * atr,
        quality: "choppy",
      };

    case "D":
      return { kind: "avoid", resistance: vwap90 };

    case "C":
      return { kind: "overextended" };
  }
}
