import { isEarlyBreakevenCondition } from "@/lib/config/commercialSpec";
import { getPrisma } from "@/lib/db/prisma";

/**
 * 满足提前保本宏观条件的交易日集合，供轮动与个股两套风控引擎共用。
 *
 * 缺当日宏观状态时该日不入集合，即退回 +10% 常态档——宁可晚保本，
 * 也不要因为数据缺口误判成提前保本而砍掉还在跑的仓位。
 *
 * 只在 `COMMERCIAL_SPEC.earlyBreakeven` 打开时才应调用。
 */
export async function loadEarlyBreakevenDates(): Promise<Set<string>> {
  const rows = await getPrisma().macroPhaseState.findMany({
    select: { date: true, pathId: true, prob5dDown: true },
  });
  return new Set(
    rows
      .filter((r) => isEarlyBreakevenCondition(r.pathId, r.prob5dDown))
      .map((r) => r.date.toISOString().slice(0, 10)),
  );
}
