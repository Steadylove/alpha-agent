import { fetchFmpProfile } from "@/lib/data-sources/fmp";
import { fetchSp500Universe } from "@/lib/data-sources/sp500";
import { fetchManyDailyBars } from "@/lib/data-sources/marketData";
import { stockUniverse as fallbackUniverse } from "@/lib/fixtures/universe";
import { withPoolExtras } from "@/lib/opportunity/extraSectors";
import { readSignalPoolMembers } from "@/lib/fund/signalPool";
import { writeSnapshot } from "@/lib/vps/snapshot";
import { buildZhBlurb, formatIndustryLabel } from "@/lib/i18n/gicsZh";
import { percentChange, percentileRank } from "@/lib/scoring/indicators";
import { BASE_RPS_THRESHOLD, passesBaseRps, type RpsQuad } from "@/lib/scoring/rpsPlaybooks";
import { generateAlphaAnalysis } from "@/lib/data-sources/deepseekAlphaAnalyst";
import type { DailyBar, Instrument } from "@/lib/types/market";

/**
 * 每日筛选：标普 + 现网池，四周期 RPS 均 > BASE_RPS_THRESHOLD，附中文行业与简介。
 */

const RPS_WINDOWS = [20, 50, 120, 250] as const;

export type ScreenerRow = {
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  /** 中文行业标签，如 能源｜炼油与营销 */
  industryLabel: string;
  /** 中文简介 */
  blurb: string;
  rps: Record<(typeof RPS_WINDOWS)[number], number>;
  rpsAvg: number;
  minRps: number;
  /** AI Alpha 分析报告 */
  alphaAnalysis?: string;
};

export type ScreenerResult = {
  generatedAt: Date;
  universeSize: number;
  rankedSize: number;
  baseThreshold: number;
  elite: ScreenerRow[];
  newHighs: ScreenerRow[];
  dailyFetchErrors: number;
};

export type RankedScreener = {
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  industryLabel: string;
  rps: Record<(typeof RPS_WINDOWS)[number], number>;
  prevRps250: number | null;
  elite: boolean;
  newHigh: boolean;
};

export const RPS_LOOKBACK_BARS = 5;

function returnOverWindow(bars: DailyBar[], window: number): number | null {
  return percentChange(
    bars.map((b) => b.close),
    window,
  );
}

function computeMultiRps(
  candidates: Array<{ symbol: string; bars: DailyBar[] }>,
): Map<string, Record<(typeof RPS_WINDOWS)[number], number>> {
  const returnsByWindow = new Map<number, number[]>();
  for (const w of RPS_WINDOWS) {
    returnsByWindow.set(
      w,
      candidates.map((c) => returnOverWindow(c.bars, w) ?? 0),
    );
  }

  const result = new Map<string, Record<(typeof RPS_WINDOWS)[number], number>>();
  for (let i = 0; i < candidates.length; i += 1) {
    const rps = {} as Record<(typeof RPS_WINDOWS)[number], number>;
    for (const w of RPS_WINDOWS) {
      const universe = returnsByWindow.get(w)!;
      rps[w] = percentileRank(universe[i], universe);
    }
    result.set(candidates[i].symbol, rps);
  }
  return result;
}

function toRpsQuad(rps: Record<(typeof RPS_WINDOWS)[number], number>): RpsQuad {
  return {
    r20: rps[20],
    r50: rps[50],
    r120: rps[120],
    r250: rps[250],
  };
}

function isNewHigh(bars: DailyBar[], lookback = 252): boolean {
  if (bars.length < 2) return false;
  const currentHigh = bars[bars.length - 1].high;
  const startIdx = Math.max(0, bars.length - 1 - lookback);
  let maxPreviousHigh = -Infinity;
  for (let i = startIdx; i < bars.length - 1; i++) {
    if (bars[i].high > maxPreviousHigh) {
      maxPreviousHigh = bars[i].high;
    }
  }
  return currentHigh > maxPreviousHigh;
}

function applyZhFields(row: ScreenerRow) {
  row.industryLabel = formatIndustryLabel(row.sector, row.industry);
  row.blurb = buildZhBlurb(row.name, row.sector, row.industry);
}

type AlphaScreenerJobOptions = {
  skipAi?: boolean;
};

export async function runAlphaScreenerJob(
  options: AlphaScreenerJobOptions = {},
): Promise<ScreenerResult> {
  const generatedAt = new Date();

  const sp500 = await fetchSp500Universe();
  const members = await readSignalPoolMembers().catch(() => [] as string[]);
  const universe: Instrument[] = withPoolExtras(sp500.length > 0 ? sp500 : fallbackUniverse, members);
  const symbols = universe.map((u) => u.symbol);
  const instrumentBySymbol = new Map(universe.map((u) => [u.symbol, u]));

  const { barsBySymbol, errors: dailyErrors } = await fetchManyDailyBars(symbols, {
    concurrency: 8,
  });

  const dailyCandidates = symbols
    .map((s) => ({ symbol: s, bars: barsBySymbol.get(s) ?? [] }))
    .filter((c) => c.bars.length >= 250);

  const rpsMap = computeMultiRps(dailyCandidates);
  const prevCandidates = dailyCandidates
    .map((c) => ({ symbol: c.symbol, bars: c.bars.slice(0, -RPS_LOOKBACK_BARS) }))
    .filter((c) => c.bars.length >= 250);
  const prevRps = computeMultiRps(prevCandidates);

  const eliteBase: ScreenerRow[] = [];
  const newHighsBase: ScreenerRow[] = [];
  const allTargetRows = new Map<string, ScreenerRow>();

  for (const { symbol, bars } of dailyCandidates) {
    const rps = rpsMap.get(symbol);
    if (!rps) continue;
    
    const isElite = passesBaseRps(toRpsQuad(rps));
    const isBreakout = isNewHigh(bars, 252);

    if (!isElite && !isBreakout) continue;

    const inst = instrumentBySymbol.get(symbol);
    const name = inst?.name ?? symbol;
    const sector = inst?.sector ?? null;
    const industry = inst?.industry ?? null;
    const row: ScreenerRow = {
      symbol,
      name,
      sector,
      industry,
      industryLabel: formatIndustryLabel(sector, industry),
      blurb: buildZhBlurb(name, sector, industry),
      rps,
      rpsAvg: RPS_WINDOWS.reduce((sum, w) => sum + rps[w], 0) / RPS_WINDOWS.length,
      minRps: Math.min(rps[20], rps[50], rps[120], rps[250]),
    };
    
    allTargetRows.set(symbol, row);

    if (isElite) eliteBase.push(row);
    if (isBreakout) newHighsBase.push(row);
  }

  eliteBase.sort((a, b) => b.minRps - a.minRps || b.rpsAvg - a.rpsAvg);
  newHighsBase.sort((a, b) => b.rpsAvg - a.rpsAvg);

  // FMP 仅用于补全英文 sector/industry，再转中文（简介不使用英文长描述）
  // 并且并发请求 AI 深度分析
  {
    const queue = Array.from(allTargetRows.values());
    // 使用少量并发避免触发限制
    const workers = Array.from({ length: Math.min(3, queue.length || 1) }, async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) return;

        // 1. 行业信息
        try {
          // console.log(`Fetching FMP for ${row.symbol}`);
          const profile = await fetchFmpProfile(row.symbol);
          if (profile) {
            if (profile.sector) row.sector = profile.sector;
            if (profile.industry) row.industry = profile.industry;
          }
        } catch (e) {
          console.error(`fetchFmpProfile failed for ${row.symbol}`, e);
        }
        applyZhFields(row);

        // 2. AI 深度分析 (仅对 elite 执行，避免新高太多耗尽 token)
        if (!options.skipAi && eliteBase.includes(row)) {
          try {
            console.log(`Analyzing AI for ${row.symbol}`);
            const bars = barsBySymbol.get(row.symbol) ?? [];
            let currentPrice = 0;
            let volumeChange: number | undefined;
            
            if (bars.length > 0) {
              const lastBar = bars[bars.length - 1];
              currentPrice = lastBar.close;
              if (bars.length >= 2) {
                const prevBar = bars[bars.length - 2];
                if (prevBar.volume && lastBar.volume) {
                  volumeChange = (lastBar.volume - prevBar.volume) / prevBar.volume;
                }
              }
            }
            
            if (currentPrice > 0) {
              const analysis = await generateAlphaAnalysis(row, currentPrice, volumeChange);
              if (analysis) {
                row.alphaAnalysis = analysis;
              }
            }
            console.log(`Finished AI for ${row.symbol}`);
          } catch (e) {
            console.error(`generateAlphaAnalysis failed for ${row.symbol}`, e);
          }
        }
      }
    });
    await Promise.all(workers);
    console.log("All workers finished");
  }

  const result: ScreenerResult = {
    generatedAt,
    universeSize: universe.length,
    rankedSize: dailyCandidates.length,
    baseThreshold: BASE_RPS_THRESHOLD,
    elite: eliteBase,
    newHighs: newHighsBase,
    dailyFetchErrors: Object.keys(dailyErrors).length,
  };

  const eliteSet = new Set(eliteBase.map((r) => r.symbol));
  const newHighSet = new Set(newHighsBase.map((r) => r.symbol));
  const ranked: RankedScreener[] = dailyCandidates.flatMap(({ symbol }) => {
    const rps = rpsMap.get(symbol);
    if (!rps) return [];
    const inst = instrumentBySymbol.get(symbol);
    const sector = inst?.sector ?? null;
    const industry = inst?.industry ?? null;
    return [
      {
        symbol,
        name: inst?.name ?? symbol,
        sector,
        industry,
        industryLabel: formatIndustryLabel(sector, industry),
        rps,
        prevRps250: prevRps.get(symbol)?.[250] ?? null,
        elite: eliteSet.has(symbol),
        newHigh: newHighSet.has(symbol),
      },
    ];
  });

  writeSnapshot("screener", {
    date: generatedAt.toISOString().slice(0, 10),
    ...result,
    ranked,
  });

  return result;
}
