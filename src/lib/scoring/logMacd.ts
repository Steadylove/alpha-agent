/**
 * 对数 MACD 底背离（❤️ 一买 / ⭐️ 二买）。
 *
 * 对齐通达信原始公式的买入侧（'BUY' 与 'B' 两个标记），
 * 而非 Pine 第 68~108 行——Pine 在移植时把 `INTPART` 写成了 `math.floor`，
 * 详见 reduceByMagnitude。卖出侧（'S'）尚未实现，回测用 ATR 吊灯止损替代。
 *
 * 「对数」指的是把 DIF 与历史低点先按各自量级规约到同一位数再比较
 * （trunc(x / 10^(trunc(log10|lv|)-1))），避免用绝对差值判背离时
 * 因标的价格量级不同而失真。
 *
 * Pine 语义要点：任何 na 参与的比较结果为 false，本模块用 null 安全比较复现。
 */

import { barsSinceSeries, crossSeries, emaSeries, highestSeries } from "./series";

/** 通达信原式的 `TW := 4`，顶背离比较实体上沿时的固定窗口。 */
const TOP_WINDOW = 4;

export type LogMacdBar = {
  high: number;
  low: number;
  close: number;
  /**
   * 开盘价，只用于顶背离取实体上沿 `TP_P := MAX(C, O)`。
   *
   * 缺省时实体上沿退化为收盘价：面板里 open 列是后加的，旧行没有。
   * 退化只影响二买的顶背离否决项，不影响一买。
   */
  open?: number;
};

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
  /** 顶背离：DEA 掉头那根上实体上沿创新高而 DIF 未创新高。二买的否决项。 */
  divergenceTop: boolean;
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

/**
 * 按量级规约到同一位数后取整，用于跨周期比较 DIF 高低。
 *
 * 取整用 trunc 而非 floor：原始通达信公式写的是 `INTPART`（向零截断），
 * 而通达信另有 `FLOOR`（向下取整）可选，作者选的是前者。两者在负数上不等价
 * （INTPART(-37.5) = -37，floor(-37.5) = -38），而底背离要求 MACD < 0、
 * DIF 通常也在零轴下方，所以这个差别几乎每次判断都会碰上。
 *
 * 指数那一步同理：`|reference| < 1` 时 LOG 为负，INTPART(-0.301) = 0 而
 * floor(-0.301) = -1，规约位数会整体差一个数量级。
 */
export function reduceByMagnitude(
  numerator: (number | null)[],
  reference: (number | null)[],
): (number | null)[] {
  const out: (number | null)[] = new Array(numerator.length).fill(null);
  for (let i = 0; i < numerator.length; i += 1) {
    const num = numerator[i];
    const ref = reference[i];
    if (num == null || ref == null || ref === 0) continue;
    const exponent = Math.trunc(Math.log10(Math.abs(ref))) - 1;
    out[i] = Math.trunc(num / 10 ** exponent);
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

  // 顶背离 TOP_D：DEA 掉头那根上，实体上沿创了新高而 DIF 没有。
  // 它本身不是卖点，只作为二买的否决项（详见 condBuy1 里的 noRecentTop）。
  const bodyTop = bars.map((b) => Math.max(b.close, b.open ?? b.close));
  const hhvBody = highestSeries(bodyTop, TOP_WINDOW);
  const deaTurnedDown: boolean[] = dea.map(
    (_, i) => i >= 2 && lt(dea[i], dea[i - 1]) && lt(dea[i - 2], dea[i - 1]),
  );
  const tpddD = barsSinceSeries(shiftOne(deaTurnedDown));
  const prevHhvBody = shiftByCycle(hhvBody, tpddD);
  const prevDifAtTop = shiftByCycle(dif, tpddD);

  const topD: boolean[] = new Array(n).fill(false);
  for (let i = 0; i < n; i += 1) {
    topD[i] =
      deaTurnedDown[i] && lt(prevHhvBody[i], hhvBody[i]) && lt(dif[i], prevDifAtTop[i]);
  }
  const topDays = barsSinceSeries(topD);

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
    // 最近一次顶背离要比最近一次死叉更久远，即死叉之后没再出过顶背离。
    // 尚未出现过顶背离时 barsSince 为 null，比较取 false 而非放行：
    // 与本模块其余 na 语义一致，且只影响序列开头预热段。
    const noRecentTop = gt(topDays[i], dcD1[i]);
    condBuy1[i] = goldenCross && orderRight && weakRegime && noRecentTop;
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
    divergenceTop: topD[i],
    buy1: gt(bsPrevBuy[i], 10) && condBuy[i],
    buy2: gt(bsPrevBuy1[i], 10) && condBuy1[i],
  }));
}
