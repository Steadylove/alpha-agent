/**
 * 传导拓扑自洽战术指令仲裁引擎。
 *
 * 对齐「MarketCompass」Pine 第 774~864 行。
 *
 * 这是整套系统的出口：把 MPR 路径、持仓状态、买点信号、形态阶段收敛成一条指令。
 * 仲裁分三层，**持仓优先**：
 *   1. 有持仓 —— 只按 MPR 路径决定守法，不再看形态
 *   2. 空仓且有点火 —— MPR 路径决定放行、轻仓还是冻结
 *   3. 空仓无信号 —— MPR 路径与形态阶段共同决定
 *
 * 本模块只产出结构化判定，文案留给展示层，避免把 emoji 与措辞钉死在计算里。
 *
 * ## 与 Pine 的一处刻意偏离：`holding` 的取值时点
 *
 * Pine 的风控段（第 14 节）跑在仲裁段（第 15 节）**之前**，点火当根就把
 * `entryPrice1` 填上了，等第 15 节判 `not na(entryPrice1)` 时已经算「持仓」。
 * 后果是第 2 层「买点触发仲裁」永远够不着——而它的注释明写着
 * 「空仓状态下出现信号」，意图与实现相反。全历史 771 次点火里 584 次
 * 本该落在第 2 层，实际 0 次。
 *
 * 这里传入的 `holding` 取 `heldBeforeThisBar`，即**排除本根刚开的仓位**，
 * 让第 2 层按其注释的意图生效。建仓当根因此会给出 enter_* 而不是 hold_*。
 */

import type { StockStage } from "./stockStage";

export type TacticalTone = "danger" | "caution" | "neutral" | "favorable";

export type TacticalAction =
  /** 持仓中，宏观顺风，可依托移动止盈放大利润 */
  | "hold_ride"
  /** 持仓中，宏观转弱，收紧防守但不强制离场 */
  | "hold_defend"
  /** 持仓中，宏观破位，禁止加仓、分批锁利 */
  | "hold_derisk"
  /** 点火且宏观健康，按标准风控建仓 */
  | "enter_standard"
  /** 点火但宏观逆风，轻仓试错 */
  | "enter_light"
  /** 点火但宏观高危，冻结不接 */
  | "enter_frozen"
  /** 空仓，宏观高危，全面防御 */
  | "wait_defensive"
  /** 空仓，等回踩低吸 */
  | "wait_dip"
  /** 空仓，高位或破位，禁止介入 */
  | "wait_avoid"
  /** 空仓，震荡箱体套利 */
  | "range_trade"
  /** 空仓，突破带右侧顺势 */
  | "breakout_follow"
  /** 空仓，混沌筑底左侧分批 */
  | "accumulate";

export interface TacticalVerdict {
  action: TacticalAction;
  tone: TacticalTone;
  /** 触发该判定的仲裁层，便于面板解释「为什么是这条」 */
  layer: "holding" | "signal" | "regime";
}

export interface TacticalInput {
  /** 本根开仓之前就已持仓，取 `StockRiskDay.heldBeforeThisBar` */
  holding: boolean;
  buy1: boolean;
  buy2: boolean;
  /** 平滑 RSI 闸门是否放行 */
  rsiOk: boolean;
  /** MPR 传导路径 0~4 */
  pathId: number;
  stage: StockStage;
}

export function computeTacticalGuide(input: TacticalInput): TacticalVerdict {
  const { holding, buy1, buy2, rsiOk, pathId, stage } = input;

  // 第 1 层：持仓追踪。Pine 在这一层完全不看形态阶段。
  if (holding) {
    if (pathId === 4) return { action: "hold_derisk", tone: "danger", layer: "holding" };
    if (pathId === 2) return { action: "hold_derisk", tone: "danger", layer: "holding" };
    if (pathId === 1) return { action: "hold_defend", tone: "caution", layer: "holding" };
    if (pathId === 3) return { action: "hold_defend", tone: "neutral", layer: "holding" };
    return { action: "hold_ride", tone: "favorable", layer: "holding" };
  }

  // 第 2 层：空仓遇点火
  if ((buy1 || buy2) && rsiOk) {
    if (pathId === 4 || pathId === 2) {
      return { action: "enter_frozen", tone: "danger", layer: "signal" };
    }
    if (pathId === 1) return { action: "enter_light", tone: "caution", layer: "signal" };
    return { action: "enter_standard", tone: "neutral", layer: "signal" };
  }

  // 第 3 层：空仓无信号，形态与宏观共同决定
  if (pathId === 4 || pathId === 2) {
    return { action: "wait_defensive", tone: "danger", layer: "regime" };
  }

  if (pathId === 1) {
    if (stage === "A") return { action: "wait_dip", tone: "caution", layer: "regime" };
    if (stage === "C") return { action: "wait_avoid", tone: "danger", layer: "regime" };
    if (stage === "D") return { action: "wait_avoid", tone: "danger", layer: "regime" };
    return { action: "wait_dip", tone: "caution", layer: "regime" };
  }

  switch (stage) {
    case "C":
      return { action: "wait_avoid", tone: "danger", layer: "regime" };
    case "D":
      return { action: "wait_avoid", tone: "danger", layer: "regime" };
    case "W":
      return { action: "range_trade", tone: "neutral", layer: "regime" };
    case "A":
      return { action: "breakout_follow", tone: "favorable", layer: "regime" };
    case "E":
      return { action: "accumulate", tone: "neutral", layer: "regime" };
    case "B":
      return { action: "wait_dip", tone: "neutral", layer: "regime" };
  }
}
