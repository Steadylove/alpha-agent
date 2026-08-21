import { getPrisma } from "@/lib/db/prisma";
import {
  MPR_SYMBOLS,
  alignMprInputs,
  computeMprSeries,
  type AlignBar,
  type MprDay,
  type MprSymbol,
} from "@/lib/scoring/mpr";

/**
 * 每日重算 MPR 并落库到 MacroPhaseState。
 *
 * 重算而非增量:MPR 的 ECDF 是 252 日滚动分位,昨天的分位会随今天的新数据而改变,
 * 只追加最新一天会让历史值与重算结果不一致。全序列重算只要 42ms,不值得做增量。
 */

/** 每次任务回写的天数。覆盖节假日空档,同时避免每天重写全部历史。 */
const UPSERT_DAYS = 30;

export type MacroPhaseJobResult = {
  latestDate: string | null;
  pathId: number | null;
  marketRiskScore: number | null;
  /** 相对前一交易日是否发生路径切换,Phase 6 的推送门控要用。 */
  pathChanged: boolean;
  previousPathId: number | null;
  seriesLength: number;
  recordsWritten: number;
};

async function loadBars(): Promise<{ bySymbol: Record<MprSymbol, AlignBar[]>; missing: string[] }> {
  const prisma = getPrisma();
  const instruments = await prisma.instrument.findMany({
    where: { symbol: { in: [...MPR_SYMBOLS] } },
    select: { id: true, symbol: true },
  });

  const found = new Set(instruments.map((i) => i.symbol));
  const missing = MPR_SYMBOLS.filter((s) => !found.has(s));
  const bySymbol = {} as Record<MprSymbol, AlignBar[]>;
  for (const symbol of MPR_SYMBOLS) bySymbol[symbol] = [];
  if (missing.length > 0) return { bySymbol, missing };

  const bars = await prisma.dailyBar.findMany({
    where: { instrumentId: { in: instruments.map((i) => i.id) } },
    orderBy: { date: "asc" },
    select: { instrumentId: true, date: true, close: true, volume: true },
  });

  const symbolById = new Map(instruments.map((i) => [i.id, i.symbol as MprSymbol]));
  for (const bar of bars) {
    const symbol = symbolById.get(bar.instrumentId);
    if (!symbol) continue;
    bySymbol[symbol].push({
      date: bar.date.toISOString().slice(0, 10),
      close: bar.close,
      volume: Number(bar.volume),
    });
  }
  return { bySymbol, missing: [] };
}

const toRow = (day: MprDay) => ({
  date: new Date(`${day.date}T00:00:00.000Z`),
  pathId: day.pathId,
  fsmState: day.fsmState,
  marketRiskScore: day.marketRiskScore,
  prob5dDown: day.prob5dDown,
  f1: day.f1,
  f2: day.f2,
  f3: day.f3,
  f4: day.f4,
  f5: day.f5,
  rawTerm: day.rawTerm,
  rawCred: day.rawCred,
  domVol: day.domVol,
  domCred: day.domCred,
  domSpot: day.domSpot,
  spyDamage: day.spyDamage,
  leadGap: day.leadGap,
  leadPersist: day.leadPersist,
  leadQuality: day.leadQuality,
  transVel: day.transVel,
});

export async function runMacroPhaseJob(): Promise<MacroPhaseJobResult> {
  const prisma = getPrisma();
  const startedAt = new Date();
  let recordsWritten = 0;

  try {
    const { bySymbol, missing } = await loadBars();
    if (missing.length > 0) {
      throw new Error(`缺少宏观标的 ${missing.join(", ")}，请先执行 npm run backfill:macro`);
    }

    const rows = alignMprInputs(bySymbol);
    const series = computeMprSeries(rows);
    if (series.length === 0) {
      throw new Error("对齐后无可用交易日");
    }

    // 先删后插而非逐条 upsert：30 次 upsert 即使包在 $transaction 里仍是 30 次往返，
    // 在 Neon 上会撞上 5s 的事务超时。删+插只有两条语句。
    const rowsToWrite = series.slice(-UPSERT_DAYS).map(toRow);
    await prisma.$transaction([
      prisma.macroPhaseState.deleteMany({
        where: { date: { in: rowsToWrite.map((r) => r.date) } },
      }),
      prisma.macroPhaseState.createMany({ data: rowsToWrite }),
    ]);
    recordsWritten = rowsToWrite.length;

    const latest = series.at(-1)!;
    const previous = series.at(-2) ?? null;
    const finishedAt = new Date();

    await prisma.jobRun.create({
      data: {
        name: "macro-phase",
        status: "SUCCESS",
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        recordsRead: rows.length,
        recordsWritten,
        details: {
          latestDate: latest.date,
          pathId: latest.pathId,
          fsmState: latest.fsmState,
          marketRiskScore: Number(latest.marketRiskScore.toFixed(2)),
          previousPathId: previous?.pathId ?? null,
        },
      },
    });

    return {
      latestDate: latest.date,
      pathId: latest.pathId,
      marketRiskScore: latest.marketRiskScore,
      pathChanged: previous != null && previous.pathId !== latest.pathId,
      previousPathId: previous?.pathId ?? null,
      seriesLength: series.length,
      recordsWritten,
    };
  } catch (error) {
    const finishedAt = new Date();
    await prisma.jobRun.create({
      data: {
        name: "macro-phase",
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
