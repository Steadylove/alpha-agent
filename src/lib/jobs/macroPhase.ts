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
 * 全序列重算而非只算最新一天:MPR 有 252 日 ECDF 预热和跨日状态递推,
 * 必须从序列起点连续算。反正只要 42ms。
 *
 * 之所以回写一个窗口而不是只写最新一天:某天的 MPR 值本身是稳定的
 * (所有序列函数都只看当前及过去),但底层日线会被回补修正——例如补入 DXY
 * 就改变了对齐后的共同交易日集合,进而改变历史值。回写窗口能自愈这类修正。
 */

/** 每次任务回写的天数。需覆盖前端时间轴的展示长度,并为节假日留余量。 */
const UPSERT_DAYS = 180;

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
