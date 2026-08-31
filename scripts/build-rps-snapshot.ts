import { writeFileSync } from "node:fs";

import type { Timeframe } from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import {
  RPS_SNAPSHOT_PATH,
  type RpsEntry,
  type RpsSnapshot,
} from "@/lib/backtest/rpsSnapshot";
import { DEFAULT_SMALL_FUND_POOL } from "@/lib/backtest/smallFundPools";

/**
 * 把每只标的最后一根的截面 RPS 落成 data/rps-latest.json，供 /api/tv/alert 读。
 * 见 rpsSnapshot.ts 头部：这一步在请求里做要十几秒，TV 的 webhook 等不了。
 */

/** 只有这两档有面板，与 /api/tv/alert 的 RPS_PANELS 一致。 */
const TIMEFRAMES: readonly Timeframe[] = ["1d", "4h"];

async function tableFor(tf: Timeframe): Promise<Record<string, RpsEntry>> {
  const universe = await getPreparedUniverse("SMALLFUND", tf, DEFAULT_SMALL_FUND_POOL);
  const table: Record<string, RpsEntry> = {};

  for (const sym of universe.symbols) {
    const last = sym.rps.length - 1;
    if (last < 0) continue;

    // 0 表示当日未进入截面（回看未齐），与「不在池里」同等对待，直接不写
    const rps = sym.rps[last];
    if (rps < 1) continue;

    table[sym.ticker] = {
      rps: Number(rps.toFixed(2)),
      asOf: universe.axis[sym.axisIndex[last]],
    };
  }

  return table;
}

async function main() {
  const timeframes: RpsSnapshot["timeframes"] = {};
  const failed: Timeframe[] = [];

  for (const tf of TIMEFRAMES) {
    try {
      const table = await tableFor(tf);
      const asOf = Object.values(table).map((e) => e.asOf).sort().at(-1) ?? "—";
      timeframes[tf] = table;
      console.log(`[rps] ${tf} ${Object.keys(table).length} 只  截至 ${asOf}`);
    } catch (error) {
      failed.push(tf);
      console.warn(`[rps] ${tf} 跳过：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 日线是主档，线上缺了等于没有闸门，宁可让构建失败也不要静默上线
  if (!timeframes["1d"]) {
    const msg = "[rps] 日线快照生成失败，先跑 npm run smallfund:fetch。";
    if (process.env.VERCEL) {
      console.error(msg);
      process.exit(1);
    }
    console.log(msg);
  }

  const snapshot: RpsSnapshot = {
    generatedAt: new Date().toISOString(),
    poolId: DEFAULT_SMALL_FUND_POOL,
    timeframes,
  };

  writeFileSync(RPS_SNAPSHOT_PATH, JSON.stringify(snapshot));
  console.log(
    `[rps] 已写入 ${RPS_SNAPSHOT_PATH}` + (failed.length > 0 ? `，缺 ${failed.join("/")}` : ""),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
