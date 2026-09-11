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
  version: number;
  asOf: string;
  rows: FundScoreRow[];
  failures?: { symbol: string; error: string }[];
};

// 版本升级使旧取数逻辑生成的快照立即失效；36 小时容许日更任务的正常延迟。
export const FUND_SCORE_VERSION = 2;
export const FUND_SCORE_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const ALERT_LOOKUP_TIMEOUT_MS = 2_500;

export function distFrom52w(closes: number[]): number | null {
  if (closes.length < 60) return null;
  const window = closes.slice(Math.max(0, closes.length - 253), -1);
  const high = Math.max(...window);
  const close = closes.at(-1);
  if (!close || high <= 0) return null;
  return ((close - high) / high) * 100;
}

export async function scoreSymbol(symbol: string, name: string, closes?: number[], options: { asOf?: string; signal?: AbortSignal } = {}): Promise<FundScoreRow> {
  const financials = await fetchSecFundInputs(symbol, options);
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
  const rows: FundScoreRow[] = [];
  const failures: { symbol: string; error: string }[] = [];
  for (const row of universe) {
    try {
      const signal = AbortSignal.timeout(12_000);
      const bars = await loadDailyBars([row.symbol], signal);
      const closes = bars.get(row.symbol)?.map((bar) => bar.close);
      rows.push(await scoreSymbol(row.symbol, row.name, closes, { signal }));
    } catch (error) {
      failures.push({ symbol: row.symbol, error: error instanceof Error ? error.message : String(error) });
      console.warn(`[fund-score] ${row.symbol} 更新失败，跳过该股`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!rows.length && failures.length) throw new Error("基本面评分全部更新失败，保留原快照但不延长有效期");
  const snapshot = { version: FUND_SCORE_VERSION, asOf: new Date().toISOString(), rows, failures };
  writeSnapshot("fund-score", snapshot);
  return snapshot;
}

export function isFreshFundSnapshot(snapshot: FundScoreSnapshot, now = Date.now()): boolean {
  const age = now - Date.parse(snapshot.asOf);
  return snapshot.version === FUND_SCORE_VERSION && Number.isFinite(age) && age >= 0 && age <= FUND_SCORE_MAX_AGE_MS;
}

/** 买卖点卡用：旧版本/过期快照重新算；缺维、超时和失败均不阻塞信号推送。 */
export async function lookupAlertFundScore(symbol: string): Promise<FundScore | undefined> {
  const controller = new AbortController();
  const load = async () => {
    try {
      const snapshot = await readSnapshot<FundScoreSnapshot>("fund-score", controller.signal);
      const hit = snapshot && isFreshFundSnapshot(snapshot)
        ? snapshot.rows.find((row) => row.symbol.toUpperCase() === symbol.toUpperCase()) : undefined;
      if (hit?.score.usable) return hit.score;
    } catch {
      /* 快照缺失时现场算 */
    }
    controller.signal.throwIfAborted();
    const bars = await loadDailyBars([symbol], controller.signal);
    controller.signal.throwIfAborted();
    const row = await scoreSymbol(symbol, symbol, bars.get(symbol)?.map((bar) => bar.close), { signal: controller.signal });
    return row.score.usable ? row.score : undefined;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      load().catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(undefined); }, ALERT_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function fundScoreLine(row: FundScoreRow): string {
  const { score } = row;
  const dims = score.dims
    .map((dim) => `${dim.label} ${dim.value == null ? "—" : formatFundRatio(dim.id, dim.value)} ${dim.points}/${dim.max}`)
    .join(" · ");
  return `${row.symbol} ${score.tier ?? "未齐"} ${score.total} ${dims}`;
}
