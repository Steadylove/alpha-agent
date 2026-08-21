/**
 * SLS 3.0 行业板块生命周期时钟。
 *
 * 对齐「MarketCompass」Pine 第 158~279 行。
 *
 * 两个维度：
 *   - SLS 分数 = 63 日绝对涨幅比率，用来排「谁是领涨主线」
 *   - 21 日超额 = 相对基准的 21 日比率差，用来找「谁在资金回流」
 *
 * 全部取值滞后一根（Pine 用的是 `close[1]` / `close[22]` / `close[64]`），
 * 因此当日盘中不会用到当日收盘价，天然没有未来函数。
 */

import type { SectorClockId } from "./sectorUniverse";
import { SECTOR_UNIVERSE } from "./sectorUniverse";

export type SectorClockStatus = "leader" | "bottoming" | "neutral" | "outflow";

export interface SectorClockDay {
  /** 63 日比率，ETF 尚未上市时为 0（Pine 的 na 兜底） */
  scores: Record<SectorClockId, number>;
  /** 相对基准的 21 日比率差 */
  mom21: Record<SectorClockId, number>;
  /** SLS 前三名，即「领涨主线」 */
  top3: SectorClockId[];
  /** 涨幅落后但资金已回流的板块：SLS < 1.05 且 21 日超额 > 0.01 */
  bottoming: SectorClockId[];
  /** bottoming 为空时的兜底展示：21 日超额最高的板块 */
  rotatingLeader: SectorClockId;
}

export interface SectorClockInput {
  /** 11 档收盘价，必须已按同一交易日轴对齐；ETF 未上市的日期填 null */
  sectorCloses: Record<SectorClockId, readonly (number | null)[]>;
  /** 基准（SPY）收盘价，同一交易日轴 */
  benchmarkCloses: readonly (number | null)[];
}

const IDS = SECTOR_UNIVERSE.map((s) => s.id);

/** Pine 的 close[lag]，越界或缺失记 null。 */
const at = (values: readonly (number | null)[], i: number, lag: number) =>
  i - lag < 0 ? null : (values[i - lag] ?? null);

export function computeSectorClockSeries(input: SectorClockInput): SectorClockDay[] {
  const { sectorCloses, benchmarkCloses } = input;
  const n = benchmarkCloses.length;

  for (const id of IDS) {
    if (sectorCloses[id].length !== n) {
      throw new Error(
        `行业 ${id} 序列与基准长度不一致: ${sectorCloses[id].length} vs ${n}，请先按交易日对齐`,
      );
    }
  }

  const days: SectorClockDay[] = [];

  for (let i = 0; i < n; i += 1) {
    const benchC0 = at(benchmarkCloses, i, 1);
    const benchC21 = at(benchmarkCloses, i, 22);
    const benchMom =
      benchC0 != null && benchC21 != null && benchC21 > 0 ? benchC0 / benchC21 : 1;

    const scores = {} as Record<SectorClockId, number>;
    const mom21 = {} as Record<SectorClockId, number>;

    for (const id of IDS) {
      const series = sectorCloses[id];
      const c0 = at(series, i, 1);
      const c21 = at(series, i, 22);
      const c63 = at(series, i, 64);

      scores[id] = c0 != null && c63 != null && c63 > 0 ? c0 / c63 : 0;
      mom21[id] = (c0 != null && c21 != null && c21 > 0 ? c0 / c21 : 1) - benchMom;
    }

    // Pine 用三轮「取最大且排除已选」的循环，严格大于比较，并列时下标小的先入选
    const top3: SectorClockId[] = [];
    for (let round = 0; round < 3; round += 1) {
      let best: SectorClockId | null = null;
      let bestVal = Number.NEGATIVE_INFINITY;
      for (const id of IDS) {
        if (top3.includes(id)) continue;
        if (scores[id] > bestVal) {
          bestVal = scores[id];
          best = id;
        }
      }
      if (best) top3.push(best);
    }

    const bottoming = IDS.filter((id) => scores[id] < 1.05 && mom21[id] > 0.01);

    let rotatingLeader = IDS[0];
    let bestMom = Number.NEGATIVE_INFINITY;
    for (const id of IDS) {
      if (mom21[id] > bestMom) {
        bestMom = mom21[id];
        rotatingLeader = id;
      }
    }

    days.push({ scores, mom21, top3, bottoming, rotatingLeader });
  }

  return days;
}

export interface SectorStanding {
  sector: SectorClockId;
  /** 1~11，值越小越强 */
  rank: number;
  status: SectorClockStatus;
  sls: number;
  mom21: number;
}

/**
 * 某个行业在当日时钟里的站位。
 *
 * 注意排名的判定与 top3 不完全等价：Pine 用 `1 + count(其他分数 > 本行业分数)`，
 * 并列时所有并列者共享同一名次。
 */
export function sectorStanding(day: SectorClockDay, sector: SectorClockId): SectorStanding {
  const sls = day.scores[sector];
  const mom = day.mom21[sector];

  let rank = 1;
  for (const id of IDS) {
    if (day.scores[id] > sls) rank += 1;
  }

  const status: SectorClockStatus =
    rank <= 3 ? "leader" : sls < 1.02 && mom > 0.02 ? "bottoming" : rank <= 6 ? "neutral" : "outflow";

  return { sector, rank, status, sls, mom21: mom };
}
