import { writeFileSync } from "node:fs";

import { getPreparedUniverse } from "@/lib/backtest/load";
import { SMALL_FUND_UNIVERSE } from "@/lib/backtest/smallFundUniverse";
import { CHAMPS } from "@/lib/fund/champs";
import { runRotate } from "@/lib/fund/rotate";

/**
 * 用现 4H 定档泡 sf-broad，对照 sf-2026-08。不定参、不写 champs。
 *
 *   NODE_OPTIONS=--max-old-space-size=8192 npx --yes tsx scripts/soak-broad.ts
 */

const SEG3 = [
  { from: "2021-08-24", to: "2023-04-24" },
  { from: "2023-04-24", to: "2024-12-24" },
  { from: "2024-12-24", to: "2026-08-24" },
] as const;

const sf = new Set(SMALL_FUND_UNIVERSE);

function pack(r: ReturnType<typeof runRotate>) {
  const extra = r.lotPnl.filter((x) => !sf.has(x.symbol));
  const core = r.lotPnl.filter((x) => sf.has(x.symbol));
  const sum = (xs: { pct: number }[]) => xs.reduce((a, b) => a + b.pct, 0);
  const top = [...r.lotPnl].sort((a, b) => b.pct - a.pct).slice(0, 12);
  return {
    cagr: +r.cagr.toFixed(2),
    dd: +r.dd.toFixed(2),
    mar: +r.mar.toFixed(2),
    entries: r.entries,
    avgHold: +r.avgHoldings.toFixed(2),
    avgExp: +r.avgExposure.toFixed(1),
    lots: r.lotPnl.length,
    extraLots: extra.length,
    extraPnl: +sum(extra).toFixed(1),
    corePnl: +sum(core).toFixed(1),
    top,
  };
}

async function soak(poolId: "sf-2026-08" | "sf-broad") {
  const champ = CHAMPS.find((c) => c.id === "4h")!;
  const uni = await getPreparedUniverse("SMALLFUND", "4h", poolId);
  const full = runRotate(uni, champ.config, champ.opts);
  const segs = SEG3.map((w) => {
    const r = runRotate(uni, { ...champ.config, ...w }, champ.opts);
    return { ...w, cagr: +r.cagr.toFixed(1), dd: +r.dd.toFixed(1), mar: +r.mar.toFixed(2), entries: r.entries };
  });
  const m3cagr = Math.min(...segs.map((s) => s.cagr));
  const m3dd = Math.max(...segs.map((s) => s.dd));
  return {
    poolId,
    symbols: uni.symbols.length,
    full: pack(full),
    segs,
    m3: +(m3dd > 0 ? m3cagr / m3dd : 0).toFixed(2),
  };
}

async function main() {
  const t0 = Date.now();
  const old = await soak("sf-2026-08");
  const broad = await soak("sf-broad");
  const out = { elapsedMs: Date.now() - t0, champ: "4h 止8吊10无盈门0 8% RSI≥30", old, broad };
  writeFileSync("/tmp/soak-broad-4h.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main();
