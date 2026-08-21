/**
 * 对数 MACD 底背离（❤️ 一买 / ⭐️ 二买）。
 *
 * 严格对齐「美股动能满仓轮动雷达」Pine 第 68~108 行。
 *
 * 「对数」指的是把 DIF 与历史低点先按各自量级规约到同一位数再比较
 * （floor(x / 10^(floor(log10|lv|)-1))），避免用绝对差值判背离时
 * 因标的价格量级不同而失真。
 *
 * Pine 语义要点：任何 na 参与的比较结果为 false，本模块用 null 安全比较复现。
 */

import { barsSinceSeries, crossSeries, emaSeries } from "./series";

export type LogMacdBar = { high: number; low: number; close: number };

export type LogMacdDay = {
  dif: number | null;
  dea: number | null;
  macd: number | null;
  /** 死叉：DIF 下穿 DEA。 */
  deathCross: boolean;
  barsSinceDeathCross: number | null;
  /** 与上一轮下跌周期比较的底背离。 */
  divergenceDirect: boolean;
  /** 与上上轮下跌周期比较的底背离（中间那轮不算数时的退路）。 */
  divergenceIndirect: boolean;
  /** ❤️ 一买：背离成立后 DIF 拐头向上。 */
  buy1: boolean;
  /** ⭐️ 二买：背离后金叉，且处于长期弱势区。 */
  buy2: boolean;
};

const gt = (a: number | null, b: number | null) => a != null && b != null && a > b;
const lt = (a: number | null, b: number | null) => a != null && b != null && a < b;
const lte = (a: number | null, b: number | null) => a != null && b != null && a <= b;

/** 对含前导 null 的序列做 EMA：跳过前导缺失段，其后按 ta.ema 递推。 */
function emaOfNullable(values: (number | null)[], length: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const start = values.findIndex((v) => v != null);
  if (start < 0) return out;

  const compact = values.slice(start) as number[];
  const inner = emaSeries(compact, length);
  for (let i = 0; i < inner.length; i += 1) out[start + i] = inner[i];
  return out;
}

/** ta.lowest，窗口长度逐根变化；窗口内出现 null 则该根为 null。 */
function lowestDynamic(
  values: (number | null)[],
  lengths: (number | null)[],
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i += 1) {
    // nz(dc_d1) + 1：从未死叉时窗口退化为当根
    const len = (lengths[i] ?? 0) + 1;
    const from = i - len + 1;
    if (from < 0) continue;

    let best: number | null = null;
    let hasNull = false;
    for (let j = from; j <= i; j += 1) {
      const v = values[j];
      if (v == null) {
        hasNull = true;
        break;
      }
      if (best == null || v < best) best = v;
    }
    out[i] = hasNull ? null : best;
  }
  return out;
}

/** Pine 的动态回溯 `x[dc_d1 + 1]`：取上一个下跌周期结束前那根的值。 */
function shiftByCycle(
  values: (number | null)[],
  barsSinceDc: (number | null)[],
): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i += 1) {
    const dc = barsSinceDc[i];
    if (dc == null) continue;
    const j = i - (dc + 1);
    if (j < 0) continue;
    out[i] = values[j];
  }
  return out;
}

/** 按量级规约到同一位数后取整，用于跨周期比较 DIF 高低。 */
function reduceByMagnitude(
  numerator: (number | null)[],
  reference: (number | null)[],
): (number | null)[] {
  const out: (number | null)[] = new Array(numerator.length).fill(null);
  for (let i = 0; i < numerator.length; i += 1) {
    const num = numerator[i];
    const ref = reference[i];
    if (num == null || ref == null || ref === 0) continue;
    const exponent = Math.floor(Math.log10(Math.abs(ref))) - 1;
    out[i] = Math.floor(num / 10 ** exponent);
  }
  return out;
}

const shiftOne = (values: boolean[]): boolean[] => [false, ...values.slice(0, -1)];

export function computeLogMacdSeries(bars: LogMacdBar[]): LogMacdDay[] {
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const dif: (number | null)[] = ema12.map((v, i) =>
    v == null || ema26[i] == null ? null : (v - ema26[i]!) * 100,
  );
  const dea = emaOfNullable(dif, 9);
  const macd: (number | null)[] = dif.map((v, i) =>
    v == null || dea[i] == null ? null : (v - dea[i]!) * 2,
  );

  const condMacdNeg: boolean[] = macd.map(
    (v, i) => i > 0 && v != null && v < 0 && macd[i - 1] != null && macd[i - 1]! < 0,
  );

  const rawDeathCross = crossSeries(dea, dif);
  const deathCross: boolean[] = rawDeathCross.map(
    (c, i) => c && i > 0 && lt(dea[i - 1], dif[i - 1]),
  );
  const dcD1 = barsSinceSeries(deathCross);

  const lvC1 = lowestDynamic(closes, dcD1);
  const lvC2 = shiftByCycle(lvC1, dcD1);
  const lvC3 = shiftByCycle(lvC2, dcD1);

  const lvD1 = lowestDynamic(dif, dcD1);
  const lvD2 = shiftByCycle(lvD1, dcD1);
  const lvD3 = shiftByCycle(lvD2, dcD1);

  const difLd2 = reduceByMagnitude(dif, lvD2);
  const difLd3 = reduceByMagnitude(dif, lvD3);
  const llvLd2 = reduceByMagnitude(lvD2, lvD2);
  const llvLd3 = reduceByMagnitude(lvD3, lvD3);

  const divergenceDirect: boolean[] = new Array(n).fill(false);
  const divergenceIndirect: boolean[] = new Array(n).fill(false);
  for (let i = 1; i < n; i += 1) {
    divergenceDirect[i] =
      condMacdNeg[i] &&
      gt(difLd2[i], llvLd2[i]) &&
      lte(difLd2[i], difLd2[i - 1]) &&
      lt(lvC1[i], lvC2[i]);

    divergenceIndirect[i] =
      condMacdNeg[i] &&
      gt(difLd3[i], llvLd3[i]) &&
      lte(difLd3[i], difLd3[i - 1]) &&
      lt(lvC1[i], lvC3[i]) &&
      lt(lvC3[i], lvC2[i]);
  }

  const condBuy: boolean[] = new Array(n).fill(false);
  const btmDis: boolean[] = new Array(n).fill(false);
  for (let i = 1; i < n; i += 1) {
    condBuy[i] =
      (gt(difLd2[i], difLd2[i - 1]) && divergenceDirect[i - 1]) ||
      (gt(difLd3[i], difLd3[i - 1]) && divergenceIndirect[i - 1]);

    btmDis[i] =
      (divergenceDirect[i - 1] && lte(lvD1[i], lvD2[i])) ||
      (divergenceIndirect[i - 1] && lte(lvD1[i], lvD3[i]));
  }

  const anyDivergence: boolean[] = divergenceDirect.map((v, i) => v || divergenceIndirect[i]);
  const bsBtmDis = barsSinceSeries(btmDis);
  const bsAnyDiv = barsSinceSeries(anyDivergence);

  const rawGoldenCross = crossSeries(dif, dea);
  const emaHigh24 = emaSeries(highs, 24);
  const emaLow90 = emaSeries(lows, 90);

  const condBuy1: boolean[] = new Array(n).fill(false);
  for (let i = 1; i < n; i += 1) {
    const goldenCross = rawGoldenCross[i] && lt(dif[i - 1], dea[i - 1]);
    const orderRight =
      lt(bsBtmDis[i], bsAnyDiv[i]) && lt(bsAnyDiv[i], dcD1[i]);
    const weakRegime =
      lt(emaHigh24[i], emaLow90[i]) || lt(emaHigh24[i - 1], emaLow90[i - 1]);
    condBuy1[i] = goldenCross && orderRight && weakRegime;
  }

  // ta.barssince(cond[1]) > 10：从未触发过时为 na，比较结果 false
  const bsPrevBuy = barsSinceSeries(shiftOne(condBuy));
  const bsPrevBuy1 = barsSinceSeries(shiftOne(condBuy1));

  return bars.map((_, i) => ({
    dif: dif[i],
    dea: dea[i],
    macd: macd[i],
    deathCross: deathCross[i],
    barsSinceDeathCross: dcD1[i],
    divergenceDirect: divergenceDirect[i],
    divergenceIndirect: divergenceIndirect[i],
    buy1: gt(bsPrevBuy[i], 10) && condBuy[i],
    buy2: gt(bsPrevBuy1[i], 10) && condBuy1[i],
  }));
}
