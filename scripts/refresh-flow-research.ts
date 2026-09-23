import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { readDeskJson } from "@/lib/fund/deskRemote";
import { marketBaseUrl, csvDir, rpsScaleFile, rpsSnapshotFile } from "@/lib/backtest/marketStore";
import { fetchMarketText, loadMarketPanel } from "@/lib/backtest/marketRemote";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import { readCsvPanel, writeCsvPanel } from "@/lib/backtest/csvPanel";
import { fetchAlpacaDailyBars } from "@/lib/data-sources/alpaca";
import { lastSettledSession } from "@/lib/backtest/mergeBars";
import { optionFlowPath, optionFlowOf } from "@/lib/optionFlow/store";
import { flowResearchSymbols } from "@/lib/optionFlow/research/universe";

/** Explicit local backfill command; daily production chain already refreshes this universe. */
async function main() {
  const raw = marketBaseUrl() && !process.env.OPTION_FLOW_PATH ? await readDeskJson("option-flow.json", AbortSignal.timeout(20000))
    : existsSync(optionFlowPath()) ? JSON.parse(readFileSync(optionFlowPath(), "utf8")) : null;
  if (!raw) throw new Error("没有期权流来源");
  if (process.argv.includes("--seed-sources")) {
    if (!marketBaseUrl()) throw new Error("初始化需要配置数据服务器");
    const [scale, rps, spy] = await Promise.all([
      fetchMarketText("rps/rps-scale-spx.json", AbortSignal.timeout(30000)),
      fetchMarketText("rps/rps-latest.json", AbortSignal.timeout(30000)),
      loadMarketPanel("1d", "SPY", AbortSignal.timeout(30000)),
    ]);
    if (!scale || !rps || !spy) throw new Error("初始化来源不完整");
    writeJsonAtomic(optionFlowPath(), raw);
    writeJsonAtomic(rpsScaleFile(), JSON.parse(scale));
    writeJsonAtomic(rpsSnapshotFile(), JSON.parse(rps));
    writeCsvPanel(csvDir("1d"), "SPY", spy.dates.map((date, i) => ({ date, open: spy.open?.[i] ?? spy.close[i], high: spy.high[i], low: spy.low[i], close: spy.close[i], volume: spy.volume?.[i] ?? 0 })));
  }
  const day = lastSettledSession();
  const symbols = flowResearchSymbols(optionFlowOf(raw).posts, day).filter(s => s !== "SPX");
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - 730 * 86400000).toISOString().slice(0, 10);
  const failed: string[] = [];
  for (let i = 0; i < symbols.length; i += 3) {
    await Promise.all(symbols.slice(i, i + 3).map(async ticker => {
      const old = readCsvPanel(csvDir("1d"), ticker);
      if (old?.dates.at(-1) === day && old.dates.length >= 280) return;
      try {
        const bars = (await fetchAlpacaDailyBars(ticker, from)).filter(b => b.date <= day);
        if (!bars.length) throw new Error("empty");
        // Preserve older history and refresh overlapping adjusted source bars.
        const combined = new Map(old?.dates.map((date, j) => [date, { date, open: old.open?.[j] ?? old.close[j], high: old.high[j], low: old.low[j], close: old.close[j], volume: old.volume?.[j] ?? 0 }]) ?? []);
        for (const bar of bars) combined.set(bar.date, bar);
        writeCsvPanel(csvDir("1d"), ticker, [...combined.values()].sort((a, b) => a.date.localeCompare(b.date)));
      } catch { failed.push(ticker); }
    }));
    console.log(`[flow] 日线检查 ${Math.min(i + 3, symbols.length)}/${symbols.length}`);
  }
  console.log(JSON.stringify({ through: day, symbols: symbols.length, failed }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "补采失败"); process.exitCode = 1; });
