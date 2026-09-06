import { getPreparedUniverse } from "@/lib/backtest/load";
import { champOf, type ChampId } from "@/lib/fund/champs";
import { bookContrib, pickByRank, type LookbackPickTf, type ScoreRow } from "@/lib/fund/lookbackPickLogic";
import { runRotate } from "@/lib/fund/rotate";

async function scoreBook(id: ChampId, from: string, to?: string): Promise<ScoreRow[]> {
  const champ = champOf(id);
  const uni = await getPreparedUniverse("SMALLFUND", champ.config.timeframe, champ.poolId);
  const end = to ?? uni.axis.at(-1) ?? champ.config.to;
  const raw = runRotate(uni, { ...champ.config, from, to: end }, champ.opts);
  return bookContrib(raw.lotPnl, raw.holdings.at(-1)?.rows ?? []);
}

export async function pickLookbackPool(
  from: string,
  n: number,
  tf: LookbackPickTf,
  to?: string,
): Promise<{ members: string[]; scored: number }> {
  const four = tf === "2h" ? [] : await scoreBook("4h", from, to);
  const two = tf === "4h" ? [] : await scoreBook("2h-broad", from, to);
  const members = pickByRank(four, two, n);
  return { members, scored: new Set([...four, ...two].map((r) => r.ticker)).size };
}