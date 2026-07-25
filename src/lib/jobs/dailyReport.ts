import { sendDailyReportDiscordWebhook } from "@/lib/discord/sendWebhook";
import { fetchLatestSkew, fetchLatestVix, scoreSkew, scoreVix } from "@/lib/data-sources/cboe";
import { generateReportInsights } from "@/lib/data-sources/deepseek";
import { fetchMoatVerdictsBatch } from "@/lib/data-sources/deepseekMoat";
import { fetchFinnhubMarketNews } from "@/lib/data-sources/finnhubNews";
import {
  emptyFundamentals,
  fetchFmpDeepFundamentals,
  fetchFmpIncomeBasics,
  type FundamentalSnapshot,
} from "@/lib/data-sources/fmp";
import { fetchManyDailyBars } from "@/lib/data-sources/marketData";
import { fetchSp500Universe } from "@/lib/data-sources/sp500";
import { getPrisma } from "@/lib/db/prisma";
import { sectorEtfs, stockUniverse as fallbackUniverse } from "@/lib/fixtures/universe";
import { renderDailyReport } from "@/lib/report/renderDailyReport";
import { computeExecutionPlan } from "@/lib/scoring/execution";
import { scoreMacroSafety } from "@/lib/scoring/macro";
import { computeWatchlistChanges } from "@/lib/scoring/portfolio";
import { scoreSectors } from "@/lib/scoring/sector";
import { scoreStocks } from "@/lib/scoring/stock";
import type { DailyBar, Instrument, NewsItem, WatchlistStatus } from "@/lib/types/market";

const toDate = (date: string) => new Date(`${date}T00:00:00.000Z`);

// 分层策略保 FMP 免费额度 250/天不超：
//   Layer 1: BASIC_LIMIT × 1 endpoint (income-statement)
//   Layer 2: DEEP_LIMIT × 3 endpoint (ratios-ttm + grades + price-target)
// 100×1 + 30×3 = 190 次，留 60 缓冲
const BASIC_CANDIDATE_LIMIT = 100;
const DEEP_CANDIDATE_LIMIT = 30;

async function upsertInstruments(instruments: Instrument[]) {
  const prisma = getPrisma();
  for (const instrument of instruments) {
    await prisma.instrument.upsert({
      where: { symbol: instrument.symbol },
      update: {
        name: instrument.name,
        type: instrument.type,
        sector: instrument.sector,
        industry: instrument.industry,
        exchange: instrument.exchange,
        isActive: true,
      },
      create: {
        symbol: instrument.symbol,
        name: instrument.name,
        type: instrument.type,
        sector: instrument.sector,
        industry: instrument.industry,
        exchange: instrument.exchange,
      },
    });
  }
}

async function persistBars(barsBySymbol: Map<string, DailyBar[]>) {
  const prisma = getPrisma();
  for (const [symbol, bars] of barsBySymbol) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) continue;

    for (const bar of bars.slice(-370)) {
      await prisma.dailyBar.upsert({
        where: {
          instrumentId_date: {
            instrumentId: instrument.id,
            date: toDate(bar.date),
          },
        },
        update: {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: BigInt(Math.trunc(bar.volume)),
          source: bar.source,
        },
        create: {
          instrumentId: instrument.id,
          date: toDate(bar.date),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: BigInt(Math.trunc(bar.volume)),
          source: bar.source,
        },
      });
    }
  }
}

async function persistNewsItems(newsItems: NewsItem[]) {
  const prisma = getPrisma();

  for (const item of newsItems) {
    await prisma.newsItem.upsert({
      where: {
        source_externalId: {
          source: item.source,
          externalId: item.externalId,
        },
      },
      update: {
        date: toDate(item.date),
        category: item.category,
        headline: item.headline,
        summary: item.summary,
        url: item.url,
        imageUrl: item.imageUrl,
        relatedSymbols: item.relatedSymbols,
        publishedAt: new Date(item.publishedAt),
      },
      create: {
        externalId: item.externalId,
        date: toDate(item.date),
        source: item.source,
        category: item.category,
        headline: item.headline,
        summary: item.summary,
        url: item.url,
        imageUrl: item.imageUrl,
        relatedSymbols: item.relatedSymbols,
        publishedAt: new Date(item.publishedAt),
      },
    });
  }
}

export async function runDailyReportJob() {
  const startedAt = new Date();
  let recordsWritten = 0;
  const prisma = getPrisma();

  try {
    // 1. 拉取 S&P 500 成分股列表，失败则回退到 15 只种子池
    const sp500 = await fetchSp500Universe();
    const stockUniverse = sp500.length > 0 ? sp500 : fallbackUniverse;
    await upsertInstruments([...sectorEtfs, ...stockUniverse]);

    // 2. 抓行情（带并发限制，避免打爆 Yahoo/Stooq）
    const symbols = [...new Set([...sectorEtfs, ...stockUniverse].map((item) => item.symbol))];
    const { barsBySymbol, errors } = await fetchManyDailyBars(symbols, { concurrency: 10 });

    const latestDate =
      Array.from(barsBySymbol.values())
        .flat()
        .map((bar) => bar.date)
        .sort()
        .at(-1) ?? new Date().toISOString().slice(0, 10);

    const sectorScores = scoreSectors(sectorEtfs, barsBySymbol);

    // 3. 第一轮不带基本面打分，从全池选出 Top N 做深度评分
    const eligibleCandidates = stockUniverse
      .map((instrument) => ({
        instrument,
        bars: barsBySymbol.get(instrument.symbol) ?? [],
      }))
      .filter((candidate) => candidate.bars.length >= 63);

    // 3. 宏观：优先算，因为 Environment 分要接入 Stock 打分
    const [skew, vix] = await Promise.all([fetchLatestSkew(), fetchLatestVix()]);
    const marketMetric = scoreMacroSafety({
      date: latestDate,
      hygBars: barsBySymbol.get("HYG"),
      tltBars: barsBySymbol.get("TLT"),
      stockBars: stockUniverse.map((stock) => barsBySymbol.get(stock.symbol) ?? []),
      skewScore: scoreSkew(skew),
      pcrScore: scoreVix(vix),
    });

    // 4. 第一轮：无 fundamentals 粗排，选 Top N 拉基础基本面
    const preliminaryScores = scoreStocks(eligibleCandidates, marketMetric);
    const basicSymbols = new Set(
      preliminaryScores.slice(0, BASIC_CANDIDATE_LIMIT).map((score) => score.symbol),
    );

    // 5. Layer 1：Top BASIC_LIMIT 只拉 income-statement 1 次（Growth + GM + GM 环降 + 稀释）
    const basicMap = new Map<string, Partial<FundamentalSnapshot>>();
    await Promise.all(
      eligibleCandidates
        .filter((c) => basicSymbols.has(c.instrument.symbol))
        .map(async (c) => {
          const basic = await fetchFmpIncomeBasics(c.instrument.symbol);
          if (basic) basicMap.set(c.instrument.symbol, basic);
        }),
    );

    // 6. 第二轮：带 basic 打分，选出真正 Top DEEP_LIMIT 做深度基本面
    const scoresAfterBasic = scoreStocks(
      eligibleCandidates.map((c) => {
        const basic = basicMap.get(c.instrument.symbol);
        return {
          ...c,
          fundamentals: basic
            ? { ...emptyFundamentals(c.instrument.symbol), ...basic }
            : undefined,
        };
      }),
      marketMetric,
    );
    const deepSymbols = new Set(
      scoresAfterBasic.slice(0, DEEP_CANDIDATE_LIMIT).map((score) => score.symbol),
    );

    // 7. Layer 2：Top DEEP_LIMIT 深度拉 ratios-ttm + grades + price-target
    const fundamentals = new Map<string, FundamentalSnapshot>();
    for (const symbol of basicSymbols) {
      const basic = basicMap.get(symbol);
      fundamentals.set(symbol, {
        ...emptyFundamentals(symbol),
        ...(basic ?? {}),
      });
    }
    await Promise.all(
      Array.from(deepSymbols).map(async (symbol) => {
        const deep = await fetchFmpDeepFundamentals(symbol);
        if (deep) {
          const existing = fundamentals.get(symbol) ?? emptyFundamentals(symbol);
          fundamentals.set(symbol, { ...existing, ...deep });
        }
      }),
    );

    // 7b. Layer 3 · Wave 3：Top DEEP_LIMIT 拉 LLM Moat（并发 2 + 200ms 间隔 + 1 次重试）
    //     成本：每只 1-2 次 DeepSeek 调用，30 只理论 30-60 次；失败兜底 3 分
    const deepInstruments = eligibleCandidates
      .filter((c) => deepSymbols.has(c.instrument.symbol))
      .map((c) => c.instrument);
    const { verdicts: moatVerdicts, stats: moatStats } = await fetchMoatVerdictsBatch(
      deepInstruments,
      2,
    );
    for (const [symbol, verdict] of moatVerdicts) {
      const existing = fundamentals.get(symbol) ?? emptyFundamentals(symbol);
      fundamentals.set(symbol, {
        ...existing,
        moatScore: verdict.score,
        moatReason: verdict.reason,
      });
    }

    // 8. 最终评分：带完整 fundamentals + Kill Switch + Final Compass Score
    const stockScores = scoreStocks(
      eligibleCandidates.map((c) => ({
        ...c,
        fundamentals: fundamentals.get(c.instrument.symbol),
      })),
      marketMetric,
    );

    // 7. 新闻
    const newsItems = await fetchFinnhubMarketNews({
      universe: stockUniverse,
      limit: 20,
    });
    await persistNewsItems(newsItems);
    recordsWritten += newsItems.length;

    // 8. Watchlist 变化（只对 PASSED 的股）
    const passedScores = stockScores.filter((s) => s.killSwitchStatus === "PASSED");
    const previousRows = await prisma.watchlistState.findMany({
      where: { date: { lt: toDate(latestDate) } },
      orderBy: { date: "desc" },
      distinct: ["symbol"],
    });
    const previousStatuses = new Map<string, WatchlistStatus>(
      previousRows.map((row) => [row.symbol, row.current as WatchlistStatus]),
    );
    const watchlistChanges = computeWatchlistChanges(passedScores, previousStatuses);

    // 9. Top 5 完整 ExecutionPlan（PWFV + Trading Target），最高 R:R 作 featured
    const top5ExecutionPlans = passedScores
      .slice(0, 5)
      .map((score) => {
        const bars = barsBySymbol.get(score.symbol);
        if (!bars) return null;
        const analystTarget = fundamentals.get(score.symbol)?.analystTargetPrice ?? null;
        return computeExecutionPlan(bars, score, analystTarget);
      })
      .filter((plan): plan is NonNullable<typeof plan> => plan != null);
    const featuredPlan =
      top5ExecutionPlans.slice().sort((a, b) => b.rewardRiskRatio - a.rewardRiskRatio)[0] ?? null;

    const reportInput = {
      date: latestDate,
      marketMetric,
      sectorScores,
      stockScores,
      watchlistChanges,
      newsItems,
      insights: await generateReportInsights({
        marketMetric,
        sectorScores,
        topStocks: passedScores.slice(0, 5),
        newsItems,
      }),
      execution: featuredPlan,
      executions: top5ExecutionPlans,
    };
    const report = renderDailyReport(reportInput);

    // 9. 持久化：仅存 basic layer + 板块 ETF + 信用债 ETF 的 bars（省数据库空间）
    const symbolsToPersist = new Set<string>([
      ...basicSymbols,
      ...sectorEtfs.map((e) => e.symbol),
    ]);
    const barsToPersist = new Map<string, DailyBar[]>();
    for (const symbol of symbolsToPersist) {
      const bars = barsBySymbol.get(symbol);
      if (bars) barsToPersist.set(symbol, bars);
    }
    await persistBars(barsToPersist);

    await prisma.marketMetric.upsert({
      where: { date: toDate(latestDate) },
      update: {
        mss: marketMetric.mss,
        skewScore: marketMetric.skewScore,
        pcrScore: marketMetric.pcrScore,
        creditScore: marketMetric.creditScore,
        breadthScore: marketMetric.breadthScore,
        confidence: marketMetric.confidence,
        details: marketMetric.details,
      },
      create: {
        date: toDate(latestDate),
        mss: marketMetric.mss,
        skewScore: marketMetric.skewScore,
        pcrScore: marketMetric.pcrScore,
        creditScore: marketMetric.creditScore,
        breadthScore: marketMetric.breadthScore,
        confidence: marketMetric.confidence,
        details: marketMetric.details,
      },
    });

    for (const score of sectorScores) {
      const instrument = await prisma.instrument.findUnique({ where: { symbol: score.symbol } });
      if (!instrument) continue;
      await prisma.sectorScore.upsert({
        where: { date_symbol: { date: toDate(latestDate), symbol: score.symbol } },
        update: score,
        create: { ...score, date: toDate(latestDate), instrumentId: instrument.id },
      });
      recordsWritten += 1;
    }

    // 只持久化 Top N 股票得分（Universe 页面 & Report 用），避免每天写 500 行
    for (const score of stockScores.slice(0, DEEP_CANDIDATE_LIMIT)) {
      const instrument = await prisma.instrument.findUnique({ where: { symbol: score.symbol } });
      if (!instrument) continue;
      const scoreData = {
        finalCompassScore: score.finalCompassScore,
        qualityScore: score.qualityScore,
        momentumScore: score.momentumScore,
        trendScore: score.trendScore,
        fundamentalScore: score.fundamentalScore,
        valuationScore: score.valuationScore,
        environmentScore: score.environmentScore,
        executionScore: score.executionScore,
        killSwitchStatus: score.killSwitchStatus,
        killSwitchReason: score.killSwitchReason,
        rank: score.rank,
        status: score.status,
        details: score.details,
      };
      await prisma.stockScore.upsert({
        where: { date_symbol: { date: toDate(latestDate), symbol: score.symbol } },
        update: scoreData,
        create: {
          ...scoreData,
          date: toDate(latestDate),
          instrumentId: instrument.id,
          symbol: score.symbol,
        },
      });
      recordsWritten += 1;
    }

    for (const change of watchlistChanges) {
      const instrument = await prisma.instrument.findUnique({ where: { symbol: change.symbol } });
      if (!instrument) continue;
      await prisma.watchlistState.upsert({
        where: { date_symbol: { date: toDate(latestDate), symbol: change.symbol } },
        update: {
          previous: change.previous,
          current: change.current,
          reason: change.reason,
        },
        create: {
          date: toDate(latestDate),
          instrumentId: instrument.id,
          symbol: change.symbol,
          previous: change.previous,
          current: change.current,
          reason: change.reason,
        },
      });
      recordsWritten += 1;
    }

    await prisma.report.upsert({
      where: { date: toDate(latestDate) },
      update: {
        title: report.title,
        summary: report.summary,
        body: report.body,
        version: report.version,
      },
      create: { ...report, date: toDate(latestDate) },
    });
    recordsWritten += 1;

    if (process.env.DISCORD_WEBHOOK_URL) {
      await sendDailyReportDiscordWebhook({
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
        reportInput,
        report,
        errors,
      });
    }

    const finishedAt = new Date();
    await prisma.jobRun.create({
      data: {
        name: "daily-report",
        status: Object.keys(errors).length > 0 ? "PARTIAL" : "SUCCESS",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        recordsRead: barsBySymbol.size,
        recordsWritten,
        details: {
          errors,
          universeSize: stockUniverse.length,
          basicCandidates: basicSymbols.size,
          deepCandidates: deepSymbols.size,
          moatCallsSuccessful: moatVerdicts.size,
          moatStats,
          skew,
          vix,
        },
      },
    });

    return { report, errors };
  } catch (error) {
    const finishedAt = new Date();
    await prisma.jobRun.create({
      data: {
        name: "daily-report",
        status: "FAILED",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        recordsWritten,
        error: error instanceof Error ? error.message : String(error),
        details: {},
      },
    });
    throw error;
  }
}
