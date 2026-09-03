import type { BacktestConfig, Timeframe } from "@/lib/backtest/engine";
import { DEFAULT_BACKTEST_CONFIG } from "@/lib/backtest/engine";
import { SMALL_FUND_FROM, SMALL_FUND_TO } from "@/lib/backtest/smallFundUniverse";

import { CHAMP_TABS, type ChampId } from "./champsMeta";
import type { RotateOpts } from "./rotate";

export type { ChampId };
export { CHAMP_TABS };

export type Champ = {
  id: ChampId;
  name: string;
  note: string;
  label: string;
  config: BacktestConfig;
  opts: RotateOpts;
};

const WINDOW = { from: SMALL_FUND_FROM, to: SMALL_FUND_TO, splitDate: "2099-01-01" } as const;

function cfg(over: Partial<BacktestConfig>, timeframe: Timeframe): BacktestConfig {
  return {
    ...DEFAULT_BACKTEST_CONFIG,
    ...WINDOW,
    useBuy1: true,
    useBuy2: true,
    requireVegas: true,
    rpsWeightPower: null,
    maxNameWeight: 0.15,
    timeframe,
    ...over,
  };
}

const COST_BPS = 10;

/** 四周期现金账本定档。数字只从 `scripts/fund-rotate.ts` / 本配置复现。 */
const meta = (id: ChampId) => CHAMP_TABS.find((t) => t.id === id)!;

export const CHAMPS: readonly Champ[] = [
  {
    ...meta("4h"),
    config: cfg(
      { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 0, requireRsi: true, minRsi: 30, rpsExit: null },
      "4h",
    ),
    opts: { slotPct: 0.08, mode: "none", edge: 0, costBps: COST_BPS, entryWindow: "dayClose", exitWindow: "all" },
  },
  {
    ...meta("2h"),
    config: cfg(
      { stopMult: 8, trailMult: 10, takeProfitR: null, rpsMin: 30, requireRsi: false, minRsi: 30, rpsExit: 10 },
      "2h",
    ),
    opts: { slotPct: 0.125, mode: "none", edge: 0, costBps: COST_BPS, entryWindow: "dayClose", exitWindow: "all" },
  },
  {
    ...meta("1d"),
    config: cfg(
      { stopMult: 4, trailMult: 8, takeProfitR: 3, rpsMin: 10, requireRsi: false, minRsi: 30, rpsExit: 10 },
      "1d",
    ),
    opts: { slotPct: 0.125, mode: "none", edge: 0, costBps: COST_BPS, entryWindow: "dayClose", exitWindow: "all" },
  },
  {
    ...meta("1h"),
    config: cfg(
      { stopMult: 6, trailMult: 8, takeProfitR: 3, rpsMin: 30, requireRsi: true, minRsi: 50, rpsExit: 30 },
      "1h",
    ),
    opts: { slotPct: 0.125, mode: "weakest", edge: 0, costBps: COST_BPS, entryWindow: "all", exitWindow: "dayClose" },
  },
];

export function champOf(id: string | null): Champ {
  return CHAMPS.find((c) => c.id === id) ?? CHAMPS[0];
}
