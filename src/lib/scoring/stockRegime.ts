/**
 * Hurst 分形指数、VCP / NR7 波动收敛、以及量能与 OBV 资金态。
 *
 * 对齐「MarketCompass」Pine 第 45~54 行（量能预计算）与第 637~672 行。
 */

import {
  emaSeries,
  lowestSeries,
  obvSeries,
  rmaSeries,
  smaSeries,
  trueRangeSeries,
} from "./series";

const HURST_WINDOW = 30;

export type HurstRegime = "trending" | "reverting" | "random";
export type VolatilityPattern = "vcp_nr7" | "nr7" | "vcp" | "inside_bar" | "normal";
export type MoneyFlow = "pocket_pivot" | "dry_up" | "inflow" | "outflow";

export interface RegimeBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StockRegimeDay {
  /**
   * 作用于日收益率的 Hurst 指数，钳制在 0~1；窗口不足或退化时为 0.5。
   * 这是面板采用的口径：0.5 即随机游走，实测中位数 0.51，分布正常展开。
   */
  hurstReturn: number;
  hurstReturnRegime: HurstRegime;
  /**
   * Pine 原口径：R/S 直接作用于收盘价。价格是累积量、自带趋势，
   * 该值实测 99.2% 的交易日都落在「强趋势」档，仅作对照保留。
   */
  hurstPrice: number;
  hurstPriceRegime: HurstRegime;
  isNr7: boolean;
  isVcp: boolean;
  volatilityPattern: VolatilityPattern;
  /** 相对 50 日均量的放量倍数 */
  volumeRatio: number;
  isPocketPivot: boolean;
  moneyFlow: MoneyFlow;
}

/**
 * 经典 R/S 重标极差法：对窗口内 30 个值去均值后累加，
 * 用极差与标准差之比的对数除以 log(30)。
 *
 * `firstValid` 之前的位置返回中性 0.5（收益率序列首根是构造出来的，需排除）。
 */
function hurstAt(values: readonly number[], index: number, firstValid: number): number {
  if (index < firstValid) return 0.5;

  const start = index - HURST_WINDOW + 1;
  let sum = 0;
  for (let i = start; i <= index; i += 1) sum += values[i];
  const mean = sum / HURST_WINDOW;

  let cum = 0;
  let maxCum = -Infinity;
  let minCum = Infinity;
  let sqDiff = 0;
  for (let i = start; i <= index; i += 1) {
    const dev = values[i] - mean;
    cum += dev;
    maxCum = Math.max(maxCum, cum);
    minCum = Math.min(minCum, cum);
    sqDiff += dev * dev;
  }

  const r = maxCum - minCum;
  const s = Math.sqrt(sqDiff / HURST_WINDOW);
  const raw = s > 0 && r > 0 ? Math.log(r / s) / Math.log(HURST_WINDOW) : 0.5;
  return Math.min(1, Math.max(0, raw));
}

function hurstRegimeOf(h: number): HurstRegime {
  return h >= 0.55 ? "trending" : h <= 0.45 ? "reverting" : "random";
}

export function computeStockRegimeSeries(bars: readonly RegimeBar[]): StockRegimeDay[] {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);

  const tr = trueRangeSeries([...bars]);
  const lowestTr7 = lowestSeries(tr, 7);

  // Pine 的 is_vcp 用 ta.atr，即 Wilder RMA 平滑
  const atr5 = rmaSeries(tr, 5);
  const atr10 = rmaSeries(tr, 10);
  const atr20 = rmaSeries(tr, 20);

  const vol50 = smaSeries(volumes, 50);
  const obv = obvSeries(closes, volumes);
  const obvEma = emaSeries(obv, 20);

  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);

  // 首根收益率无从计算，置 0 并把该口径的预热推后一根
  const returns = closes.map((c, i) =>
    i === 0 || closes[i - 1] === 0 ? 0 : (c - closes[i - 1]) / closes[i - 1],
  );

  // 下跌日成交量，用于 Pocket Pivot 的「放量超过近 10 日最大下跌量」
  const downVol = bars.map((b, i) =>
    i > 0 && (b.close < closes[i - 1] || b.close < b.open) ? b.volume : 0,
  );
  const maxDownVol10 = highestOfPrev(downVol, 10);

  return bars.map((bar, i) => {
    const hurstPrice = hurstAt(closes, i, HURST_WINDOW - 1);
    const hurstReturn = hurstAt(returns, i, HURST_WINDOW);

    const isNr7 = lowestTr7[i] != null && tr[i] <= lowestTr7[i]!;
    const isVcp =
      atr5[i] != null &&
      atr10[i] != null &&
      atr20[i] != null &&
      atr5[i]! < atr10[i]! &&
      atr10[i]! < atr20[i]!;
    const isInsideBar = i > 0 && bar.high < bars[i - 1].high && bar.low > bars[i - 1].low;

    const volatilityPattern: VolatilityPattern =
      isNr7 && isVcp ? "vcp_nr7" : isNr7 ? "nr7" : isVcp ? "vcp" : isInsideBar ? "inside_bar" : "normal";

    const volumeRatio = vol50[i] != null && vol50[i]! > 0 ? bar.volume / vol50[i]! : 1;

    const priceUp = i > 0 && (bar.close > closes[i - 1] || bar.close > bar.open);
    const aboveShortMa = bar.close > (ema20[i] ?? Infinity) || bar.close > (ema50[i] ?? Infinity);
    const isPocketPivot =
      priceUp && maxDownVol10[i] != null && bar.volume > maxDownVol10[i]! && aboveShortMa;

    const moneyFlow: MoneyFlow = isPocketPivot
      ? "pocket_pivot"
      : volumeRatio < 0.45
        ? "dry_up"
        : obvEma[i] != null && obv[i] > obvEma[i]!
          ? "inflow"
          : "outflow";

    return {
      hurstReturn,
      hurstReturnRegime: hurstRegimeOf(hurstReturn),
      hurstPrice,
      hurstPriceRegime: hurstRegimeOf(hurstPrice),
      isNr7,
      isVcp,
      volatilityPattern,
      volumeRatio,
      isPocketPivot,
      moneyFlow,
    };
  });
}

/** ta.highest(src[1], length)：不含当日的近 length 根最大值。 */
function highestOfPrev(values: number[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = length; i < values.length; i += 1) {
    let best = values[i - length];
    for (let j = i - length + 1; j < i; j += 1) best = Math.max(best, values[j]);
    out[i] = best;
  }
  return out;
}