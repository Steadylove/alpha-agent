import { getPreparedUniverse } from "@/lib/backtest/load";
import { champOf } from "@/lib/fund/champs";
import {
  DEFAULT_LOOKBACK_SLOTS,
  lookbackView,
  type LookbackTf,
  type LookbackView,
} from "@/lib/fund/lookbackLogic";
import { runRotate } from "@/lib/fund/rotate";
import { clipUniverseToSignalPool, readSignalPoolMembers } from "@/lib/fund/signalPool";

export async function runLookback(
  tf: LookbackTf,
  from: string,
  members?: readonly string[],
  slots = DEFAULT_LOOKBACK_SLOTS,
): Promise<LookbackView> {
  const champ = champOf(tf === "2h" ? "2h-broad" : tf);
  const allow = members ?? (await readSignalPoolMembers());
  const t0 = Date.now();
  const full = await getPreparedUniverse("SMALLFUND", champ.config.timeframe, champ.poolId, allow);
  console.info(`[lookback] ${tf} 准备 ${full.symbols.length}只 ${Date.now() - t0}ms`);
  const uni = await clipUniverseToSignalPool(full, allow);
  const t1 = Date.now();
  const to = uni.axis.at(-1) ?? champ.config.to;
  const raw = runRotate(
    uni,
    { ...champ.config, from, to },
    { ...champ.opts, slotPct: 1 / slots },
  );
  console.info(
    `[lookback] ${tf} 轮换 ${uni.symbols.length}只 ${raw.book.length}根 ${Date.now() - t1}ms`,
  );
  if (raw.book.length === 0) throw new Error("这段窗口没有账本");
  const lastClose = new Map(uni.symbols.map((s) => [s.ticker, s.close.at(-1) ?? 0]));
  return lookbackView({ ...raw, lastClose }, from);
}
