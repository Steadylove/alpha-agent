/**
 * MPR 传导路径 → 建议股票总敞口。
 *
 * 阶梯取自「Market Phase Radar」Pine 第 197~219 行的 exposure_str。
 * 源码给的是区间，本模块取中点作为 E_macro(Path) 的标量值。
 *
 * 用途：组合头寸 W_i = E_macro(Path) × RS_i / ΣRS_j。
 */

export type PathExposure = {
  minPct: number;
  maxPct: number;
  /** Pine 原文的敞口描述。 */
  stance: string;
};

export const PATH_EXPOSURE: Record<number, PathExposure> = {
  0: { minPct: 80, maxPct: 100, stance: "积极进攻" },
  1: { minPct: 60, maxPct: 80, stance: "保本锁利" },
  2: { minPct: 30, maxPct: 50, stance: "严格去杠杆" },
  3: { minPct: 60, maxPct: 80, stance: "防范洗盘" },
  4: { minPct: 0, maxPct: 20, stance: "现金防御" },
};

/** 区间中点，作为 E_macro(Path) 的标量。未知路径按最保守的 Path 4 处理。 */
export function macroExposurePct(pathId: number): number {
  const band = PATH_EXPOSURE[pathId] ?? PATH_EXPOSURE[4];
  return (band.minPct + band.maxPct) / 2;
}
