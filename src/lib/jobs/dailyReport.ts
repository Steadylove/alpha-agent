import { sendDailyReportDiscordWebhook } from "@/lib/discord/sendWebhook";
import { fetchLatestSkew, fetchLatestVix, scoreSkew, scoreVix } from "@/lib/data-sources/cboe";
import { generateReportInsights } from "@/lib/data-sources/deepseek";
import { fetchFinnhubMarketNews } from "@/lib/data-sources/finnhubNews";
import { fetchFmpFundamentals } from "@/lib/data-sources/fmp";
import { fetchManyDailyBars } from "@/lib/data-sources/marketData";
import { fetchSp500Universe } from "@/lib/data-sources/sp500";
import { getPrisma } from "@/lib/db/prisma";
import { sectorEtfs, stockUniverse as fallbackUniverse } from "@/lib/fixtures/universe";
import { renderDailyReport } from "@/lib/report/renderDailyReport";
import { scoreMacroSafety } from "@/lib/scoring/macro";
import { computeWatchlistChanges } from "@/lib/scoring/portfolio";
import { scoreSectors } from "@/lib/scoring/sector";
import { scoreStocks } from "@/lib/scoring/stock";
import type { DailyBar, Instrument, NewsItem, WatchlistStatus } from "@/lib/types/market";

const toDate = (date: string) => new Date(`${date}T00:00:00.000Z`);

// 从 500+ 候选中筛出多少只做深度打分（含 FMP 基本面）
// FMP 免费档 250 请求/天，每只需 2 次调用 → 100 只即接近上限
const DEEP_CANDIDATE_LIMIT = 100;

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

    const preliminaryScores = scoreStocks(eligibleCandidates, sectorScores);
    const topSymbols = new Set(
      preliminaryScores.slice(0, DEEP_CANDIDATE_LIMIT).map((score) => score.symbol),
    );

    // 4. 只对 Top N 拉 FMP 基本面（省 API 配额）
    const fundamentals = new Map(
      await Promise.all(
        eligibleCandidates
          .filter((c) => topSymbols.has(c.instrument.symbol))
          .map(async (c) => [c.instrument.symbol, await fetchFmpFundamentals(c.instrument.symbol)] as const),
      ),
    );

    const stockScores = scoreStocks(
      eligibleCandidates.map((c) => ({ ...c, fundamentals: fundamentals.get(c.instrument.symbol) })),
      sectorScores,
    );

    // 5. 新闻
    const newsItems = await fetchFinnhubMarketNews({
      universe: stockUniverse,
      limit: 20,
    });
    await persistNewsItems(newsItems);
    recordsWritten += newsItems.length;

    // 6. Watchlist 变化
    const previousRows = await prisma.watchlistState.findMany({
      where: { date: { lt: toDate(latestDate) } },
      orderBy: { date: "desc" },
      distinct: ["symbol"],
    });
    const previousStatuses = new Map<string, WatchlistStatus>(
      previousRows.map((row) => [row.symbol, row.current as WatchlistStatus]),
    );
    const watchlistChanges = computeWatchlistChanges(stockScores, previousStatuses);

    // 7. 宏观：SKEW（尾部风险）+ VIX（0DTE PCR 的可行替代）+ HYG/TLT 信用利差 + 全市场宽度
    const [skew, vix] = await Promise.all([fetchLatestSkew(), fetchLatestVix()]);
    const marketMetric = scoreMacroSafety({
      date: latestDate,
      hygBars: barsBySymbol.get("HYG"),
      tltBars: barsBySymbol.get("TLT"),
      stockBars: stockUniverse.map((stock) => barsBySymbol.get(stock.symbol) ?? []),
      skewScore: scoreSkew(skew),
      pcrScore: scoreVix(vix),
    });

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
        topStocks: stockScores.slice(0, 5),
        newsItems,
      }),
    };
    const report = renderDailyReport(reportInput);

    // 8. 持久化：仅存 Top N + 板块 ETF + 信用债 ETF 的 bars（省数据库空间）
    const symbolsToPersist = new Set<string>([
      ...topSymbols,
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
      await prisma.stockScore.upsert({
        where: { date_symbol: { date: toDate(latestDate), symbol: score.symbol } },
        update: {
          totalScore: score.totalScore,
          rpsScore: score.rpsScore,
          trendScore: score.trendScore,
          sectorScore: score.sectorScore,
          fundamentalScore: score.fundamentalScore,
          accumulationScore: score.accumulationScore,
          rank: score.rank,
          status: score.status,
          details: score.details,
        },
        create: {
          date: toDate(latestDate),
          instrumentId: instrument.id,
          symbol: score.symbol,
          totalScore: score.totalScore,
          rpsScore: score.rpsScore,
          trendScore: score.trendScore,
          sectorScore: score.sectorScore,
          fundamentalScore: score.fundamentalScore,
          accumulationScore: score.accumulationScore,
          rank: score.rank,
          status: score.status,
          details: score.details,
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
          deepCandidates: topSymbols.size,
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
