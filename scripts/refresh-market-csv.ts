import "dotenv/config";

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  CSV_1H_DIR,
  CSV_2H_DIR,
  CSV_4H_DIR,
  CSV_PANEL_DIR,
  listCsvTickers,
  readCsvPanel,
  writeCsvPanel,
  type CsvBar,
} from "@/lib/backtest/csvPanel";
import { marketDataRoot, writeManifest } from "@/lib/backtest/marketStore";
import { buildAndStoreSignalRps, fetchRpsCalendar, latestRpsSession } from "@/lib/backtest/buildSignalRps";
import { rebuildTwoHourCsv } from "@/lib/backtest/rebuildTwoHour";
import { assertFourHourShape } from "@/lib/backtest/intradayShape";
import { lastSettledSession, mergeNewBars, type OhlcvBar } from "@/lib/backtest/mergeBars";
import type { PanelBars } from "@/lib/backtest/panel";
import { tickersForPool } from "@/lib/backtest/smallFundPools";
import { fetchAlpaca30MBars, fetchAlpacaDailyBars, hasAlpacaCredentials } from "@/lib/data-sources/alpaca";
import { fetchCboeVolIndexHistory, type CboeVolIndex } from "@/lib/data-sources/cboe";
import { fetchSp500Universe } from "@/lib/data-sources/sp500";
import { fetchStooqDailyBars } from "@/lib/data-sources/stooq";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import { alpacaDataSymbol, marketDataSymbol } from "@/lib/data-sources/marketSymbol";
import { MPR_SYMBOLS } from "@/lib/scoring/mpr";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";
import {
  aggregateTo1H,
  aggregateTo4H,
  barTimeISO,
  fetchYahoo1HBars,
  type IntradayBar,
} from "@/lib/data-sources/yahooIntraday";

/**
 * 给 CSV 增量补到最近一个已收盘日。不碰数据库。
 * 设 MARKET_DATA_DIR 时写 1d/4h/2h/1h 规范布局（VPS 就是这个）。
 *
 *   npx tsx scripts/refresh-market-csv.ts
 *   MARKET_DATA_DIR=/var/lib/alpha-agent/market npx tsx scripts/refresh-market-csv.ts
 */

const KNOWN_GAP = new Set(["SKHY", "SPCX"]);
const MACRO_YAHOO: { symbol: string; fetchSymbol?: string }[] = [
  { symbol: "SPY" },
  { symbol: "RSP" },
  { symbol: "TLT" },
  { symbol: "DXY", fetchSymbol: "DX-Y.NYB" },
  { symbol: "HYG" },
  { symbol: "IEI" },
];
const MACRO_CBOE: CboeVolIndex[] = ["VIX", "VIX9D", "VIX3M"];
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? 6);
const AUDIT_ONLY = process.argv.includes("--audit");

function toBars(panel: PanelBars): OhlcvBar[] {
  return panel.dates.map((date, i) => ({
    date,
    open: panel.open?.[i] ?? panel.close[i],
    high: panel.high[i],
    low: panel.low[i],
    close: panel.close[i],
    volume: panel.volume?.[i] ?? 0,
  }));
}

function writeBars(dir: string, ticker: string, bars: OhlcvBar[]) {
  writeCsvPanel(dir, ticker, bars as CsvBar[]);
}

function lastDay(panel: PanelBars | null): string | null {
  const tip = panel?.dates.at(-1);
  return tip ? tip.slice(0, 10) : null;
}

async function mapPool<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    out.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(worker))));
  }
  return out;
}

async function fetchDaily(ticker: string, from: string): Promise<OhlcvBar[]> {
  // Yahoo 可能成功返回但少最后一个已收盘日；有付费行情时优先使用同源 SIP 日线。
  if (hasAlpacaCredentials()) return fetchAlpacaDailyBars(ticker, from);
  try {
    return await fetchYahooDailyBars(ticker, { years: 2 });
  } catch {
    const bars = await fetchStooqDailyBars(ticker);
    if (bars.length === 0) throw new Error("Yahoo/Stooq 都空");
    return bars;
  }
}

async function fetchIntraday(ticker: string, fromIso: string): Promise<IntradayBar[]> {
  if (hasAlpacaCredentials()) return fetchAlpaca30MBars(ticker, fromIso);
  const fromUnix = Math.floor(new Date(fromIso).getTime() / 1000);
  return fetchYahoo1HBars(ticker, Number.isFinite(fromUnix) ? fromUnix : undefined);
}

function auditDir(label: string, dir: string, wanted: readonly string[], until: string) {
  const have = new Set(listCsvTickers(dir));
  const missing = wanted.filter((t) => !have.has(t) && !KNOWN_GAP.has(t));
  const extra = [...have].filter((t) => !wanted.includes(t)).sort();
  const stale: { ticker: string; last: string }[] = [];
  const fresh: string[] = [];
  const empty: string[] = [];
  for (const ticker of wanted) {
    if (KNOWN_GAP.has(ticker)) continue;
    if (!have.has(ticker)) continue;
    const panel = readCsvPanel(dir, ticker);
    const last = lastDay(panel);
    if (!last) empty.push(ticker);
    else if (last < until) stale.push({ ticker, last });
    else fresh.push(ticker);
  }
  const lastCounts = new Map<string, number>();
  for (const row of stale) lastCounts.set(row.last, (lastCounts.get(row.last) ?? 0) + 1);
  const hist = [...lastCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(
    `\n[${label}] 池 ${wanted.length}  有文件 ${have.size}  齐 ${fresh.length}  落后 ${stale.length}  缺文件 ${missing.length}  空 ${empty.length}  已知无价 ${[...KNOWN_GAP].join(",")}`,
  );
  if (hist.length) {
    console.log(`  落后截止日期: ${hist.map(([d, n]) => `${d}×${n}`).join("  ")}`);
  }
  if (missing.length) console.log(`  缺文件: ${missing.join(" ")}`);
  if (empty.length) console.log(`  空文件: ${empty.join(" ")}`);
  if (extra.length && extra.length <= 12) console.log(`  池外多出来: ${extra.join(" ")}`);
  return { missing, stale, fresh };
}

async function refreshDaily(wanted: readonly string[], until: string) {
  const { missing, stale } = auditDir("1d", CSV_PANEL_DIR, wanted, until);
  const need = [...new Set([...missing, ...stale.map((s) => s.ticker)])];
  if (AUDIT_ONLY || need.length === 0) return { updated: 0, failed: [] as string[] };

  const failed: string[] = [];
  let updated = 0;
  await mapPool(need, async (ticker) => {
    try {
      const existing = readCsvPanel(CSV_PANEL_DIR, ticker);
      const merged = mergeNewBars(existing ? toBars(existing) : [], await fetchDaily(ticker, existing?.dates.at(-1) ? `${existing.dates.at(-1)}T00:00:00Z` : "2013-01-01T00:00:00Z"), until);
      if ((merged.at(-1)?.date ?? "") < until) throw new Error(`日线未更新到 ${until}`);
      if (!existing || merged.length !== existing.dates.length) {
        writeBars(CSV_PANEL_DIR, ticker, merged);
        updated += 1;
      }
    } catch (error) {
      failed.push(`${ticker}: ${error instanceof Error ? error.message : error}`);
    }
  });
  return { updated, failed };
}

async function refreshTf(
  label: "4h" | "2h" | "1h",
  dir: string,
  wanted: readonly string[],
  until: string,
  aggregate: (raw: IntradayBar[]) => OhlcvBar[],
) {
  const { missing, stale } = auditDir(label, dir, wanted, until);
  const need = [...new Set([...missing, ...stale.map((s) => s.ticker)])];
  if (AUDIT_ONLY || need.length === 0) return { updated: 0, failed: [] as string[] };

  const failed: string[] = [];
  let updated = 0;
  await mapPool(need, async (ticker) => {
    try {
      const existing = readCsvPanel(dir, ticker);
      const last = lastDay(existing) ?? "2016-01-01";
      const fromIso = new Date(`${last}T00:00:00Z`).toISOString();
      const raw = await fetchIntraday(ticker, fromIso);
      const incoming = aggregate(raw);
      const merged = mergeNewBars(existing ? toBars(existing) : [], incoming, until);
      if (label === "4h") assertFourHourShape([{ ticker, dates: merged.map((b) => b.date) }]);
      if (!existing || merged.length !== existing.dates.length) {
        writeBars(dir, ticker, merged);
        updated += 1;
      }
    } catch (error) {
      failed.push(`${ticker}: ${error instanceof Error ? error.message : error}`);
    }
  });
  return { updated, failed };
}

function toOhlcv(raw: IntradayBar[]): OhlcvBar[] {
  return raw.map((b) => ({
    date: barTimeISO(b.timestamp),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

async function refreshMacro(until: string) {
  const failed: string[] = [];
  let updated = 0;
  for (const target of MACRO_YAHOO) {
    try {
      const existing = readCsvPanel(CSV_PANEL_DIR, target.symbol);
      const incoming = await fetchYahooDailyBars(target.fetchSymbol ?? target.symbol, { years: 2 });
      const merged = mergeNewBars(existing ? toBars(existing) : [], incoming, until);
      if ((merged.at(-1)?.date ?? "") < until) throw new Error(`日线未更新到 ${until}`);
      if (!existing || merged.length !== existing.dates.length) {
        writeBars(CSV_PANEL_DIR, target.symbol, merged);
        updated += 1;
      }
    } catch (error) {
      failed.push(`${target.symbol}: ${error instanceof Error ? error.message : error}`);
    }
  }
  for (const symbol of MACRO_CBOE) {
    try {
      const existing = readCsvPanel(CSV_PANEL_DIR, symbol);
      const incoming = await fetchCboeVolIndexHistory(symbol);
      const merged = mergeNewBars(existing ? toBars(existing) : [], incoming, until);
      if ((merged.at(-1)?.date ?? "") < until) throw new Error(`日线未更新到 ${until}`);
      if (!existing || merged.length !== existing.dates.length) {
        writeBars(CSV_PANEL_DIR, symbol, merged);
        updated += 1;
      }
    } catch (error) {
      failed.push(`${symbol}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return { updated, failed };
}

async function main() {
  const calendar = hasAlpacaCredentials() ? await fetchRpsCalendar() : undefined;
  const until = calendar ? latestRpsSession(calendar) : lastSettledSession();
  if (!until) throw new Error("无法确定最近已收盘交易日");
  const benchmark = hasAlpacaCredentials() ? await fetchSp500Universe() : [];
  if (hasAlpacaCredentials() && benchmark.length < 450) throw new Error("标普名单缺失，停止刷新");
  const wanted = [
    ...new Set([
      ...tickersForPool("sf-broad"),
      ...benchmark.map(row => row.symbol),
      ...ROTATION_UNIVERSE.map((t) => t.symbol),
      ...SECTOR_UNIVERSE.map((s) => s.symbol),
      ...MPR_SYMBOLS,
    ]),
  ];
  const root = marketDataRoot();
  const markerRoot = root ?? path.join(process.cwd(), "data");
  if (!AUDIT_ONLY) {
    mkdirSync(markerRoot, { recursive: true });
    writeFileSync(path.join(markerRoot, ".market-updating"), "updating\n");
  }
  console.log(
    `已收盘日 ${until}  扩池 ${wanted.length}  源 ${hasAlpacaCredentials() ? "Alpaca" : "Yahoo"}` +
      (root ? `  目录 ${root}` : ""),
  );
  const aliases = wanted.filter((t) => marketDataSymbol(t) !== t || alpacaDataSymbol(t) !== t);
  if (aliases.length) {
    console.log(
      `行情代码映射（保留原 CSV / 账本代码）：${aliases
        .map((t) => `${t}→${hasAlpacaCredentials() ? alpacaDataSymbol(t) : marketDataSymbol(t)}`)
        .join("，")}`,
    );
  }

  const daily = await refreshDaily(
    wanted.filter((t) => !MACRO_CBOE.includes(t as CboeVolIndex) && t !== "DXY"),
    until,
  );
  const macro = await refreshMacro(until);
  const tfWanted = wanted.filter((t) => !MACRO_CBOE.includes(t as CboeVolIndex) && t !== "DXY");
  const four = await refreshTf("4h", CSV_4H_DIR, tfWanted, until, (raw) => toOhlcv(aggregateTo4H(raw)));
  const one = await refreshTf("1h", CSV_1H_DIR, tfWanted, until, (raw) => toOhlcv(aggregateTo1H(raw)));

  if (AUDIT_ONLY) return;
  const report = (name: string, r: { updated: number; failed: string[] }) => {
    console.log(`\n补 ${name}: 写入 ${r.updated}  失败 ${r.failed.length}`);
    if (r.failed.length) console.log(`  ${r.failed.slice(0, 15).join(" | ")}`);
  };
  report("1d", daily);
  report("macro", macro);
  report("4h", four);
  report("1h", one);
  if (one.failed.length) throw new Error(`1H 同步失败，停止发布 2H：${one.failed.join("；")}`);
  // 每次从完整 1H 重建，旧目录即使已经更新到今天也会被替换。
  const rebuilt = rebuildTwoHourCsv(CSV_1H_DIR, CSV_2H_DIR, tfWanted);
  report("2h", { updated: rebuilt.length, failed: [] });
  // 快照/标尺失败必须阻止发布，不能再用旧分位顶替新日期。
  await buildAndStoreSignalRps();
  if (root) {
    const man = writeManifest(root);
    console.log(`清单 ${man.timeframes["1d"]?.files ?? 0} 只日线  ${man.generatedAt}`);
  }
  rmSync(path.join(markerRoot, ".market-updating"), { force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
