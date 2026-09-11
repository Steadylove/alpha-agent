import { fetchSecFundInputs } from "@/lib/data-sources/secFacts";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { formatFundRatio, fundScoreOf, type FundScore } from "@/lib/scoring/fundScore";
import { loadDailyBars } from "@/lib/vps/loadDailyBars";
import { readSnapshot, writeSnapshot } from "@/lib/vps/snapshot";

export type FundScoreRow = {
  symbol: string;
  name: string;
  score: FundScore;
};

export type FundScoreSnapshot = {
  asOf: string;
  rows: FundScoreRow[];
};

function distFrom52w(closes: number[]): number | null {
  if (closes.length < 60) return null;
  const window = closes.slice(Math.max(0, closes.length - 253), -1);
  const high = Math.max(...window);
  const close = closes.at(-1);
  if (!close || high <= 0) return null;
  return ((close - high) / high) * 100;
}

export async function scoreSymbol(symbol: string, name: string, closes?: number[]): Promise<FundScoreRow> {
  const financials = await fetchSecFundInputs(symbol);
  const dist52w = closes ? distFrom52w(closes) : null;
  return {
    symbol,
    name,
    score: fundScoreOf({
      epsYoy: financials?.epsYoy ?? null,
      revYoy: financials?.revYoy ?? null,
      roe: financials?.roe ?? null,
      dist52w,
      gmTtm: financials?.gmTtm ?? null,
      debtEquity: financials?.debtEquity ?? null,
    }),
  };
}

export async function runFundScoreJob(symbols?: string[]): Promise<FundScoreSnapshot> {
  const universe = ROTATION_UNIVERSE.filter((row) => row.type === "STOCK").filter((row) =>
    symbols ? symbols.includes(row.symbol) : true,
  );
  const bars = await loadDailyBars(universe.map((row) => row.symbol));
  const rows: FundScoreRow[] = [];
  for (const row of universe) {
    const closes = bars.get(row.symbol)?.map((bar) => bar.close);
    rows.push(await scoreSymbol(row.symbol, row.name, closes));
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const snapshot = { asOf: new Date().toISOString(), rows };
  writeSnapshot("fund-score", snapshot);
  return snapshot;
}

/** 买卖点卡用：先读日更快照，没有再现场算。缺维不够用时不展示。 */
export async function lookupAlertFundScore(symbol: string): Promise<FundScore | undefined> {
  try {
    const snapshot = await readSnapshot<FundScoreSnapshot>("fund-score");
    const hit = snapshot?.rows.find((row) => row.symbol.toUpperCase() === symbol.toUpperCase());
    if (hit?.score.usable) return hit.score;
  } catch {
    /* 快照缺失时现场算 */
  }
  try {
    const bars = await loadDailyBars([symbol]);
    const row = await scoreSymbol(symbol, symbol, bars.get(symbol)?.map((bar) => bar.close));
    return row.score.usable ? row.score : undefined;
  } catch {
    return undefined;
  }
}

export function fundScoreLine(row: FundScoreRow): string {
  const { score } = row;
  const dims = score.dims
    .map((dim) => `${dim.label} ${dim.value == null ? "—" : formatFundRatio(dim.id, dim.value)} ${dim.points}/${dim.max}`)
    .join(" · ");
  return `${row.symbol} ${score.tier ?? "未齐"} ${score.total} ${dims}`;
}
