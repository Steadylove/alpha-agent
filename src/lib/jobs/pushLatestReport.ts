import { sendDailyReportDiscordWebhook } from "@/lib/discord/sendWebhook";
import { generateReportInsights } from "@/lib/data-sources/deepseek";
import { getPrisma } from "@/lib/db/prisma";
import { renderDailyReport } from "@/lib/report/renderDailyReport";
import type { DailyReport, DailyReportInput, WatchlistStatus } from "@/lib/types/market";

const toDateString = (date: Date) => date.toISOString().slice(0, 10);

export async function pushLatestReportFromDatabase() {
  const prisma = getPrisma();
  const reportRow = await prisma.report.findFirst({ orderBy: { date: "desc" } });

  if (!reportRow) {
    throw new Error("No report found in database.");
  }

  const date = reportRow.date;
  const [marketMetric, sectorScores, stockScores, watchlistChanges, newsItems] = await Promise.all([
    prisma.marketMetric.findUnique({ where: { date } }),
    prisma.sectorScore.findMany({ where: { date }, orderBy: { rank: "asc" } }),
    prisma.stockScore.findMany({
      where: { date },
      orderBy: { rank: "asc" },
      include: { instrument: true },
    }),
    prisma.watchlistState.findMany({ where: { date }, orderBy: { symbol: "asc" } }),
    prisma.newsItem.findMany({ where: { date }, orderBy: { publishedAt: "desc" }, take: 20 }),
  ]);

  if (!marketMetric) {
    throw new Error(`No market metric found for ${toDateString(date)}.`);
  }

  const report: DailyReport = {
    date: toDateString(reportRow.date),
    title: reportRow.title,
    summary: reportRow.summary,
    body: reportRow.body,
    version: reportRow.version,
  };
  const reportInput: DailyReportInput = {
    date: toDateString(date),
    marketMetric: {
      date: toDateString(date),
      mss: marketMetric.mss,
      skewScore: marketMetric.skewScore,
      pcrScore: marketMetric.pcrScore,
      creditScore: marketMetric.creditScore,
      breadthScore: marketMetric.breadthScore,
      confidence: marketMetric.confidence,
      details: marketMetric.details as Record<string, number | string | boolean | null>,
    },
    sectorScores: sectorScores.map((score) => ({
      symbol: score.symbol,
      name: score.name,
      rs21: score.rs21,
      rs63: score.rs63,
      score: score.score,
      rank: score.rank,
    })),
    stockScores: stockScores.map((score) => ({
      symbol: score.symbol,
      name: score.instrument.name,
      sector: score.instrument.sector ?? "Unknown",
      totalScore: score.totalScore,
      rpsScore: score.rpsScore,
      trendScore: score.trendScore,
      sectorScore: score.sectorScore,
      fundamentalScore: score.fundamentalScore,
      accumulationScore: score.accumulationScore,
      rank: score.rank,
      status: score.status as WatchlistStatus,
      details: score.details as Record<string, number | string | boolean | null>,
    })),
    watchlistChanges: watchlistChanges.map((change) => ({
      symbol: change.symbol,
      previous: change.previous as WatchlistStatus | null,
      current: change.current as WatchlistStatus,
      reason: change.reason,
    })),
    newsItems: newsItems.map((item) => ({
      externalId: item.externalId,
      date: toDateString(item.date),
      source: item.source,
      category: item.category,
      headline: item.headline,
      summary: item.summary,
      url: item.url,
      imageUrl: item.imageUrl,
      relatedSymbols: item.relatedSymbols,
      publishedAt: item.publishedAt.toISOString(),
    })),
  };

  // 每次推送都重生成 AI 洞察 + 用最新模板渲染，方便迭代 UX 时不用重跑抓取
  reportInput.insights = await generateReportInsights({
    marketMetric: reportInput.marketMetric,
    sectorScores: reportInput.sectorScores,
    topStocks: reportInput.stockScores.slice(0, 5),
    newsItems: reportInput.newsItems,
  });
  const rendered = renderDailyReport(reportInput);
  await prisma.report.update({
    where: { date },
    data: { title: rendered.title, summary: rendered.summary, body: rendered.body, version: rendered.version },
  });
  Object.assign(report, rendered);

  if (!process.env.DISCORD_WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL is required.");
  }

  await sendDailyReportDiscordWebhook({
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    reportInput,
    report,
    errors: {},
  });

  return report;
}
