import "dotenv/config";

import { existsSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { packPanel } from "@/lib/backtest/panel";
import {
  PANEL_CACHE_PATH,
  readSnapshot,
  snapshotSize,
  writeSnapshot,
  type PanelRow,
  type PanelSnapshot,
} from "@/lib/backtest/panelCache";
import { fetchNasdaq100Membership } from "@/lib/data-sources/nasdaq100Historical";
import { fetchSp500Membership, type MembershipInterval } from "@/lib/data-sources/sp500Historical";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";

/**
 * 直接从公开源重建本地面板缓存，完全不经过数据库。
 *
 * 存在的理由：这批数据原本就是从公开源抓来的——日线来自 Yahoo，时点成分区间来自
 * GitHub 上的两个 CSV 仓库。所以 Neon 出站配额打满、compute 被挂起时，
 * 不必等下个计费周期，可以照原路重建一份缓存继续调参。
 *
 * 与 backfill-sp500-panel 的关系：抓取口径（20 年窗口、MIN_BARS、失败即跳过）
 * 完全一致，区别只是终点从 Postgres 换成本地缓存文件，且不写 hasBars ——
 * 缓存里只放抓到价格的标的，这本身就等价于 hasBars = true。
 *
 * 用法:
 *   npx tsx scripts/build-panel-cache.ts
 *   BACKFILL_CONCURRENCY=3 npx tsx scripts/build-panel-cache.ts   # Yahoo 限流时降并发
 *
 * 可中断续跑：进度写在 .partial 暂存文件里，重跑会跳过已抓到的标的。
 * 只有完整跑完才落到正式缓存路径——中断留下的半成品不会被回测当成完整池子用。
 */

const HISTORY_YEARS = 20;
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? 6);
/** 对数 MACD 的 EMA90 与 RPS 的 252 根回看，短于此的样本信号不可信。 */
const MIN_BARS = 400;
/** 每抓完这么多只就存一次盘，崩了不用从头再来。 */
const CHECKPOINT_EVERY = 60;

const STAGING_PATH = path.join(
  path.dirname(PANEL_CACHE_PATH),
  `${path.basename(PANEL_CACHE_PATH, ".v8")}.partial.v8`,
);

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;

type Sourced = { index: "SP500" | "NDX100"; intervals: MembershipInterval[] };

async function fetchMembership(): Promise<Sourced[]> {
  const [sp, ndx] = await Promise.all([fetchSp500Membership(), fetchNasdaq100Membership()]);
  console.log(
    `成分区间  SP500 ${sp.intervals.length} 段 (${sp.firstDate} → ${sp.lastDate})  ` +
      `NDX100 ${ndx.intervals.length} 段 (${ndx.firstDate} → ${ndx.lastDate})`,
  );
  return [
    { index: "SP500", intervals: sp.intervals },
    { index: "NDX100", intervals: ndx.intervals },
  ];
}

/** 只要成分资格与近 20 年有交集的标的：更早就离开指数的对本窗口没有影响。 */
function targetsOf(sources: readonly Sourced[]): string[] {
  const cutoff = new Date(Date.now() - HISTORY_YEARS * 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const out = new Set<string>();
  for (const { intervals } of sources) {
    for (const iv of intervals) {
      if (iv.end == null || iv.end >= cutoff) out.add(iv.ticker);
    }
  }
  return [...out].sort();
}

type Outcome = { ticker: string; row?: PanelRow; reason?: string };

async function fetchOne(ticker: string): Promise<Outcome> {
  let bars;
  try {
    bars = await fetchYahooDailyBars(ticker, { years: HISTORY_YEARS });
  } catch (error) {
    return { ticker, reason: error instanceof Error ? error.message : "抓取失败" };
  }
  if (bars.length < MIN_BARS) return { ticker, reason: `样本不足 ${bars.length} 根` };

  const p = packPanel(bars);
  return {
    ticker,
    row: {
      ticker,
      days: p.days,
      high: p.high,
      low: p.low,
      close: p.close,
      volume: p.volume,
    },
  };
}

function assemble(panels: PanelRow[], sources: readonly Sourced[]): PanelSnapshot {
  const withBars = new Set(panels.map((p) => p.ticker));

  // 缓存里只放抓到价格的标的，等价于数据库那边的 hasBars = true 过滤
  const membership: PanelSnapshot["membership"] = [];
  for (const { index, intervals } of sources) {
    for (const iv of intervals) {
      if (!withBars.has(iv.ticker)) continue;
      membership.push({
        ticker: iv.ticker,
        index,
        startDate: new Date(`${iv.start}T00:00:00.000Z`),
        endDate: iv.end ? new Date(`${iv.end}T00:00:00.000Z`) : null,
      });
    }
  }

  return { fetchedAt: new Date().toISOString(), panels, membership };
}

async function main() {
  const sources = await fetchMembership();
  const targets = targetsOf(sources);

  // 续跑：暂存文件里已有的直接复用，不重复走网络
  const resumed = readSnapshot(STAGING_PATH);
  const panels: PanelRow[] = resumed ? [...resumed.panels] : [];
  const have = new Set(panels.map((p) => p.ticker));
  const todo = targets.filter((t) => !have.has(t));

  console.log(
    `目标 ${targets.length} 只  已有 ${have.size} 只${resumed ? "（续跑）" : ""}  本次抓 ${todo.length} 只  并发 ${CONCURRENCY}\n`,
  );

  const failed: Outcome[] = [];
  let done = 0;
  let sinceCheckpoint = 0;

  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    for (const r of await Promise.all(batch.map(fetchOne))) {
      if (r.row) panels.push(r.row);
      else failed.push(r);
    }
    done += batch.length;
    sinceCheckpoint += batch.length;

    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      writeSnapshot(STAGING_PATH, assemble(panels, sources));
      sinceCheckpoint = 0;
    }
    process.stdout.write(
      `\r进度 ${done}/${todo.length}  成功 ${panels.length}  失败 ${failed.length}   `,
    );
  }

  const snapshot = assemble(panels, sources);
  if (!writeSnapshot(STAGING_PATH, snapshot)) throw new Error("暂存文件写入失败");
  renameSync(STAGING_PATH, PANEL_CACHE_PATH);

  console.log(
    `\n\n面板 ${snapshot.panels.length} 只  成分区间 ${snapshot.membership.length} 段  ` +
      `缓存 ${mb(snapshotSize(PANEL_CACHE_PATH))} -> ${PANEL_CACHE_PATH}`,
  );

  for (const { index, intervals } of sources) {
    const withBars = new Set(snapshot.panels.map((p) => p.ticker));
    const kept = intervals.filter((iv) => withBars.has(iv.ticker)).length;
    console.log(
      `  ${index.padEnd(7)} ${kept}/${intervals.length} 段有价格 ` +
        `(${((kept / intervals.length) * 100).toFixed(0)}%)`,
    );
  }

  if (failed.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const f of failed) {
      const key = f.reason?.slice(0, 60) ?? "未知";
      byReason.set(key, [...(byReason.get(key) ?? []), f.ticker]);
    }
    console.log(`\n拿不到价格（视为已退市，回测中排除）共 ${failed.length} 只:`);
    for (const [reason, tickers] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  [${tickers.length}] ${reason}`);
      console.log(`  ${tickers.join(", ")}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  if (existsSync(STAGING_PATH)) {
    console.error(`\n进度已保留在 ${STAGING_PATH}，重跑会续上。`);
  } else {
    rmSync(STAGING_PATH, { force: true });
  }
  process.exit(1);
});
