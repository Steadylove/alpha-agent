/**
 * T-CUBE 趋势打分卡与全天候 6 大形态阶段判定。
 *
 * 对齐「MarketCompass」Pine 第 93~108 行（打分卡）与第 281~303 行（阶段闸）。
 * 本项目只有日线，因此 Pine 里 `request.security(..., 'D', ...)` 取回的 `*_D`
 * 变量在这里就是日线序列本身。
 */

import {
  atrSeries,
  emaSeries,
  highestSeries,
  smaOfNullable,
  smaSeries,
  stdevSeries,
} from "./series";

export type StockStage = "A" | "B" | "C" | "D" | "E" | "W";
export type BaseTier = "T1" | "T2" | "T3";

export interface StageBar {
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StockStageDay {
  /** 0~10，EMA 多头排列 8 分 + 斜率 2 分 */
  trendScore: number;
  /** 相对 52 周高点（不含当日）的偏离百分比，正值代表创新高后继续延伸 */
  distFrom52wHigh: number;
  /** 布林带宽 / 肯特纳带宽，>1.35 视为高波震荡 */
  squeezeRatio: number;
  /** 距上次跌破 EMA50×0.85 的交易日数，从未发生记 30（Pine 语义） */
  baseDays: number;
  baseTier: BaseTier;
  stage: StockStage;
}

function trendScoreAt(
  i: number,
  ema20: (number | null)[],
  ema50: (number | null)[],
  ema100: (number | null)[],
  ema200: (number | null)[],
  close: number,
): number {
  // Pine 的 nz(x, close)：预热期缺失值用当日收盘价顶替
  const e20 = ema20[i] ?? close;
  const e50 = ema50[i] ?? close;
  const e100 = ema100[i] ?? close;
  const e200 = ema200[i] ?? close;

  let score = 0;
  if (close > e20) score += 2;
  if (e20 > e50) score += 2;
  if (e50 > e100) score += 2;
  if (e100 > e200) score += 2;

  // 斜率项用的是 nz(x)，缺省值为 0 而非 close
  if ((ema50[i] ?? 0) > (ema50[i - 3] ?? 0)) score += 1;
  if ((ema200[i] ?? 0) > (ema200[i - 20] ?? 0)) score += 1;
  return score;
}

export function computeStockStageSeries(
  bars: readonly StageBar[],
  rsRatings: readonly number[],
): StockStageDay[] {
  const n = bars.length;
  if (rsRatings.length !== n) {
    throw new Error(`RS 序列与 K 线长度不一致: ${rsRatings.length} vs ${n}`);
  }

  const closes = bars.map((b) => b.close);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const ema100 = emaSeries(closes, 100);
  const ema200 = emaSeries(closes, 200);

  // ta.highest(close[1], 252)：不含当日，因此创新高当天 dist 为正
  const high52w = highestSeries(closes.slice(0, -1), 252);
  high52w.unshift(null);

  const kcWidth = smaOfNullable(atrSeries([...bars], 14), 20);
  const bbWidth = stdevSeries(closes, 20);

  const vwap90 = institutionalVwap(bars, 90);

  let lastBreakdown = -1;

  return bars.map((bar, i) => {
    const close = bar.close;
    const trendScore = trendScoreAt(i, ema20, ema50, ema100, ema200, close);
    const rs = rsRatings[i];

    const ref52w = high52w[i];
    const distFrom52wHigh =
      ref52w != null && ref52w > 0 ? ((close - ref52w) / ref52w) * 100 : 0;

    const kcW = kcWidth[i] != null ? 3 * kcWidth[i]! : 1;
    const bbW = bbWidth[i] != null ? 4 * bbWidth[i]! : 1;
    const squeezeRatio = kcW > 0 ? bbW / kcW : 1;

    if (close < (ema50[i] ?? close) * 0.85) lastBreakdown = i;
    const baseDays = lastBreakdown < 0 ? 30 : i - lastBreakdown;
    const baseTier: BaseTier = baseDays < 15 ? "T1" : baseDays <= 65 ? "T2" : "T3";

    const e200 = ema200[i] ?? close;
    const prevVwap = vwap90[i - 5] ?? vwap90[i];
    const vwapSlope =
      vwap90[i] != null && prevVwap != null ? (vwap90[i]! - prevVwap) / 5 : 0;

    const isSuperLeader = rs >= 80 || trendScore >= 8;

    const isC = distFrom52wHigh > 18;
    const isA =
      distFrom52wHigh >= -8 && distFrom52wHigh <= 6 && (trendScore >= 6 || rs >= 75) && !isC;
    const isD = close < e200 && trendScore <= 3 && vwapSlope < -0.03;
    const isE = close < e200 && !isD && (vwapSlope >= -0.03 || baseDays > 40);
    const isW = squeezeRatio > 1.35 && !isSuperLeader && trendScore < 6;

    // 展示优先级取自 Pine 第 302 行的三元嵌套顺序：C > D > W > A > E > B
    const stage: StockStage = isC
      ? "C"
      : isD
        ? "D"
        : isW
          ? "W"
          : isA
            ? "A"
            : isE
              ? "E"
              : "B";

    return { trendScore, distFrom52wHigh, squeezeRatio, baseDays, baseTier, stage };
  });
}

/** 机构 VWAP：sma(close×vol, n) / sma(vol, n)，无量时退化为 sma(close, n)。 */
export function institutionalVwap(
  bars: readonly { close: number; volume: number }[],
  length: number,
): (number | null)[] {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const pv = smaSeries(
    bars.map((b) => b.close * b.volume),
    length,
  );
  const v = smaSeries(volumes, length);
  const fallback = smaSeries(closes, length);

  return v.map((vol, i) => (vol != null && vol > 0 ? pv[i]! / vol : fallback[i]));
}
