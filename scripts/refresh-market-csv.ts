import "dotenv/config";

import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
import { marketDataRoot, rpsScaleFile, writeManifest } from "@/lib/backtest/marketStore";
import type { RpsScaleFile } from "@/lib/backtest/rpsScale";
import { lastSettledSession, mergeNewBars, type OhlcvBar } from "@/lib/backtest/mergeBars";
import type { PanelBars } from "@/lib/backtest/panel";
import { tickersForPool } from "@/lib/backtest/smallFundPools";
import { fetchAlpaca30MBars, hasAlpacaCredentials } from "@/lib/data-sources/alpaca";
import { fetchCboeVolIndexHistory, type CboeVolIndex } from "@/lib/data-sources/cboe";
import { fetchStooqDailyBars } from "@/lib/data-sources/stooq";
import { fetchYahooDailyBars } from "@/lib/data-sources/yahoo";
import { MPR_SYMBOLS } from "@/lib/scoring/mpr";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";
import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";
import {
  aggregateTo1H,
  aggregateTo2H,
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

async function fetchDaily(ticker: string): Promise<OhlcvBar[]> {
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
      const merged = mergeNewBars(existing ? toBars(existing) : [], await fetchDaily(ticker), until);
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

/** 日线比标尺新时，用最后一天切点往后垫，避免 assertScaleFresh 挡入场。完整重算仍走 rps:scale。 */
function extendRpsScale(until: string) {
  const path = rpsScaleFile();
  if (!existsSync(path)) return;
  const scale = JSON.parse(readFileSync(path, "utf8")) as RpsScaleFile;
  const aapl = readCsvPanel(CSV_PANEL_DIR, "AAPL");
  if (!aapl) return;
  const lastCut = scale.dates.at(-1) ?? "";
  const extra = aapl.dates.map((d) => d.slice(0, 10)).filter((d) => d > lastCut && d <= until);
  if (extra.length === 0) return;
  const lastCuts = scale.cuts.at(-1) ?? [];
  const lastCount = scale.counts.at(-1) ?? 0;
  for (const d of extra) {
    scale.dates.push(d);
    scale.cuts.push(lastCuts);
    scale.counts.push(lastCount);
  }
  writeFileSync(path, JSON.stringify(scale));
  console.log(`RPS 标尺垫到 ${extra.at(-1)}（${extra.length} 日，切点沿用 ${lastCut}）`);
}

async function refreshMacro(until: string) {
  const failed: string[] = [];
  let updated = 0;
  for (const target of MACRO_YAHOO) {
    try {
      const existing = readCsvPanel(CSV_PANEL_DIR, target.symbol);
      const incoming = await fetchYahooDailyBars(target.fetchSymbol ?? target.symbol, { years: 2 });
      const merged = mergeNewBars(existing ? toBars(existing) : [], incoming, until);
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
  const until = lastSettledSession();
  const wanted = [
    ...new Set([
      ...tickersForPool("sf-broad"),
      ...ROTATION_UNIVERSE.map((t) => t.symbol),
      ...SECTOR_UNIVERSE.map((s) => s.symbol),
      ...MPR_SYMBOLS,
    ]),
  ];
  const root = marketDataRoot();
  console.log(
    `已收盘日 ${until}  扩池 ${wanted.length}  源 ${hasAlpacaCredentials() ? "Alpaca" : "Yahoo"}` +
      (root ? `  目录 ${root}` : ""),
  );

  const daily = await refreshDaily(
    wanted.filter((t) => !MACRO_CBOE.includes(t as CboeVolIndex) && t !== "DXY"),
    until,
  );
  const macro = await refreshMacro(until);
  const tfWanted = wanted.filter((t) => !MACRO_CBOE.includes(t as CboeVolIndex) && t !== "DXY");
  const four = await refreshTf("4h", CSV_4H_DIR, tfWanted, until, (raw) => toOhlcv(aggregateTo4H(raw)));
  const two = await refreshTf("2h", CSV_2H_DIR, tfWanted, until, (raw) => toOhlcv(aggregateTo2H(raw)));
  const one = await refreshTf("1h", CSV_1H_DIR, tfWanted, until, (raw) => toOhlcv(aggregateTo1H(raw)));

  if (AUDIT_ONLY) return;
  const report = (name: string, r: { updated: number; failed: string[] }) => {
    console.log(`\n补 ${name}: 写入 ${r.updated}  失败 ${r.failed.length}`);
    if (r.failed.length) console.log(`  ${r.failed.slice(0, 15).join(" | ")}`);
  };
  report("1d", daily);
  report("macro", macro);
  report("4h", four);
  report("2h", two);
  report("1h", one);
  extendRpsScale(until);
  if (root) {
    const man = writeManifest(root);
    console.log(`清单 ${man.timeframes["1d"]?.files ?? 0} 只日线  ${man.generatedAt}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
