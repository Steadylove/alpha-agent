import { fetchFmpProfile } from "@/lib/data-sources/fmp";
import { fetchSp500Universe } from "@/lib/data-sources/sp500";
import { fetchManyDailyBars } from "@/lib/data-sources/marketData";
import { getPrisma } from "@/lib/db/prisma";
import { stockUniverse as fallbackUniverse } from "@/lib/fixtures/universe";
import { buildZhBlurb, formatIndustryLabel } from "@/lib/i18n/gicsZh";
import { percentChange, percentileRank } from "@/lib/scoring/indicators";
import { BASE_RPS_THRESHOLD, passesBaseRps, type RpsQuad } from "@/lib/scoring/rpsPlaybooks";
import { generateAlphaAnalysis } from "@/lib/data-sources/deepseekAlphaAnalyst";
import type { DailyBar, Instrument } from "@/lib/types/market";

/**
 * 每日筛选：S&P500 四周期 RPS 均 > BASE_RPS_THRESHOLD，附中文行业与简介。
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
  dailyFetchErrors: number;
};

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

function applyZhFields(row: ScreenerRow) {
  row.industryLabel = formatIndustryLabel(row.sector, row.industry);
  row.blurb = buildZhBlurb(row.name, row.sector, row.industry);
}

export async function runAlphaScreenerJob(): Promise<ScreenerResult> {
  const generatedAt = new Date();

  const sp500 = await fetchSp500Universe();
  const universe: Instrument[] = sp500.length > 0 ? sp500 : fallbackUniverse;
  const symbols = universe.map((u) => u.symbol);
  const instrumentBySymbol = new Map(universe.map((u) => [u.symbol, u]));

  const { barsBySymbol, errors: dailyErrors } = await fetchManyDailyBars(symbols, {
    concurrency: 8,
  });

  const dailyCandidates = symbols
    .map((s) => ({ symbol: s, bars: barsBySymbol.get(s) ?? [] }))
    .filter((c) => c.bars.length >= 250);

  const rpsMap = computeMultiRps(dailyCandidates);

  const eliteBase: ScreenerRow[] = [];
  for (const { symbol } of dailyCandidates) {
    const rps = rpsMap.get(symbol);
    if (!rps) continue;
    if (!passesBaseRps(toRpsQuad(rps))) continue;

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
    eliteBase.push(row);
  }

  eliteBase.sort((a, b) => b.minRps - a.minRps || b.rpsAvg - a.rpsAvg);

  // FMP 仅用于补全英文 sector/industry，再转中文（简介不使用英文长描述）
  // 并且并发请求 AI 深度分析
  {
    const queue = [...eliteBase];
    // 使用少量并发避免触发限制
    const workers = Array.from({ length: Math.min(3, queue.length || 1) }, async () => {
      while (queue.length > 0) {
        const row = queue.shift();
        if (!row) return;

        // 1. 行业信息
        try {
          const profile = await fetchFmpProfile(row.symbol);
          if (profile) {
            if (profile.sector) row.sector = profile.sector;
            if (profile.industry) row.industry = profile.industry;
          }
        } catch (e) {
          console.error(`fetchFmpProfile failed for ${row.symbol}`, e);
        }
        applyZhFields(row);

        // 2. AI 深度分析
        try {
          const bars = barsBySymbol.get(row.symbol) ?? [];
          let currentPrice = 0;
          let volumeChange: number | undefined;
          
          if (bars.length > 0) {
            // 假设最后一条是最新数据
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
        } catch (e) {
          console.error(`generateAlphaAnalysis failed for ${row.symbol}`, e);
        }
      }
    });
    await Promise.all(workers);
  }

  const result: ScreenerResult = {
    generatedAt,
    universeSize: universe.length,
    rankedSize: dailyCandidates.length,
    baseThreshold: BASE_RPS_THRESHOLD,
    elite: eliteBase,
    dailyFetchErrors: Object.keys(dailyErrors).length,
  };

  const dateKey = generatedAt.toISOString().slice(0, 10);
  const prisma = getPrisma();
  await prisma.alphaScreenerRun.upsert({
    where: { date: new Date(`${dateKey}T00:00:00.000Z`) },
    update: {
      universeSize: result.universeSize,
      targetCount: result.elite.length,
      dailyFetchErrors: result.dailyFetchErrors,
      buckets: {
        baseThreshold: result.baseThreshold,
        elite: result.elite,
      },
    },
    create: {
      date: new Date(`${dateKey}T00:00:00.000Z`),
      universeSize: result.universeSize,
      targetCount: result.elite.length,
      dailyFetchErrors: result.dailyFetchErrors,
      buckets: {
        baseThreshold: result.baseThreshold,
        elite: result.elite,
      },
    },
  });

  return result;
}
