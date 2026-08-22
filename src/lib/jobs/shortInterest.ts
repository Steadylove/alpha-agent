import { fetchLatestShortInterest } from "@/lib/data-sources/finra";
import { fetchSecSharesOutstanding, fetchSecTickerCikMap } from "@/lib/data-sources/sec";
import { getPrisma } from "@/lib/db/prisma";
import { ROTATION_UNIVERSE } from "@/lib/scoring/rotationUniverse";

/**
 * 刷新空头持仓缓存，供估值任务算轧空短线目标价。
 *
 * FINRA 双月一期、结算后第 7 个交易日才发布，因此每天跑没有意义；
 * 已有当期数据时直接跳过，不打 SEC。按日跑也只会在换期那天真正回源。
 *
 * SEC 股本变动比空头持仓慢得多，同一标的只要已有股本就沿用，
 * 避免每期把 40 只标的的 SEC 请求重打一遍。
 */

export type ShortInterestJobResult = {
  settlementDate: string | null;
  symbolsWritten: number;
  /** FINRA 窗口内没有该标的记录 */
  shortInterestMissing: string[];
  /** 拿到空头持仓但 SEC 无股本，占比无法计算（ETF 多属此类） */
  sharesMissing: string[];
  skippedAsFresh: boolean;
};

export async function runShortInterestJob(): Promise<ShortInterestJobResult> {
  const prisma = getPrisma();
  const startedAt = new Date();
  const symbols = ROTATION_UNIVERSE.map((t) => t.symbol);

  try {
    const latest = await fetchLatestShortInterest(symbols);
    if (latest.size === 0) {
      throw new Error("FINRA 窗口内无任何记录，检查回看天数或接口可用性");
    }

    const settlementDate = [...latest.values()]
      .map((r) => r.settlementDate)
      .reduce((a, b) => (b > a ? b : a));
    const settlement = new Date(`${settlementDate}T00:00:00.000Z`);

    const existing = await prisma.shortInterest.findMany({
      where: { symbol: { in: symbols } },
      select: { symbol: true, settlementDate: true, sharesOutstanding: true },
    });

    const alreadyCurrent = existing.filter(
      (e) => e.settlementDate.getTime() === settlement.getTime(),
    );
    if (alreadyCurrent.length === latest.size) {
      await logRun(startedAt, "SUCCESS", { settlementDate, skipped: true });
      return {
        settlementDate,
        symbolsWritten: 0,
        shortInterestMissing: [],
        sharesMissing: [],
        skippedAsFresh: true,
      };
    }

    // 股本沿用历史，只给从没取到过的标的打 SEC
    const knownShares = new Map<string, number>();
    for (const e of existing) {
      if (e.sharesOutstanding != null) knownShares.set(e.symbol, e.sharesOutstanding);
    }

    const needShares = symbols.filter((s) => latest.has(s) && !knownShares.has(s));
    if (needShares.length > 0) {
      const ciks = await fetchSecTickerCikMap();
      for (const symbol of needShares) {
        const cik = ciks.get(symbol);
        if (!cik) continue;
        const shares = await fetchSecSharesOutstanding(cik);
        if (shares != null && shares > 0) knownShares.set(symbol, shares);
      }
    }

    const shortInterestMissing: string[] = [];
    const sharesMissing: string[] = [];
    let symbolsWritten = 0;

    for (const symbol of symbols) {
      const record = latest.get(symbol);
      if (!record) {
        shortInterestMissing.push(symbol);
        continue;
      }
      const sharesOutstanding = knownShares.get(symbol) ?? null;
      if (sharesOutstanding == null) sharesMissing.push(symbol);

      const settlementForSymbol = new Date(`${record.settlementDate}T00:00:00.000Z`);
      await prisma.shortInterest.upsert({
        where: {
          symbol_settlementDate: { symbol, settlementDate: settlementForSymbol },
        },
        update: { sharesShort: record.sharesShort, sharesOutstanding, fetchedAt: new Date() },
        create: {
          symbol,
          settlementDate: settlementForSymbol,
          sharesShort: record.sharesShort,
          sharesOutstanding,
          fetchedAt: new Date(),
        },
      });
      symbolsWritten += 1;
    }

    await logRun(startedAt, "SUCCESS", {
      settlementDate,
      symbolsWritten,
      shortInterestMissing,
      sharesMissing,
    });

    return {
      settlementDate,
      symbolsWritten,
      shortInterestMissing,
      sharesMissing,
      skippedAsFresh: false,
    };
  } catch (error) {
    await logRun(startedAt, "FAILED", {}, error);
    throw error;
  }
}

async function logRun(
  startedAt: Date,
  status: "SUCCESS" | "FAILED",
  details: Record<string, unknown>,
  error?: unknown,
) {
  const finishedAt = new Date();
  await getPrisma().jobRun.create({
    data: {
      name: "short-interest",
      status,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      recordsWritten: Number(details.symbolsWritten ?? 0),
      error: error instanceof Error ? error.message : error ? String(error) : null,
      details: details as never,
    },
  });
}
