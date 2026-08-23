import { getPrisma } from "@/lib/db/prisma";

import { prepareUniverse, type MembershipSpan, type PreparedUniverse } from "./engine";
import { unpackPanel, type PanelBars } from "./panel";

/** 截面 RS 的基准；它不是指数成分，只作对照。 */
export const BENCHMARK_TICKER = "SPY";

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function loadPreparedUniverse(): Promise<PreparedUniverse> {
  const prisma = getPrisma();

  const [rows, spans] = await Promise.all([
    prisma.backtestPanel.findMany({
      select: { ticker: true, days: true, high: true, low: true, close: true },
    }),
    prisma.indexMembership.findMany({
      where: { hasBars: true },
      select: { ticker: true, startDate: true, endDate: true },
    }),
  ]);

  const membership = new Map<string, MembershipSpan[]>();
  for (const s of spans) {
    const list = membership.get(s.ticker) ?? [];
    list.push({ start: iso(s.startDate), end: s.endDate ? iso(s.endDate) : null });
    membership.set(s.ticker, list);
  }

  let benchmark: PanelBars | null = null;
  const panels: PanelBars[] = [];
  for (const row of rows) {
    const panel = unpackPanel(row);
    if (panel.ticker === BENCHMARK_TICKER) benchmark = panel;
    // 没有成分区间的标的进不了任何一天的截面，不必载入
    else if (membership.has(panel.ticker)) panels.push(panel);
  }

  if (!benchmark) throw new Error(`基准 ${BENCHMARK_TICKER} 的面板缺失，先跑 backfill-sp500-panel`);

  return prepareUniverse(panels, benchmark, membership);
}

/**
 * 进程内缓存。准备段只依赖行情与成分资格，参数变化不影响，
 * 而它是整条链路里最贵的一步，不能每次请求都重算。
 */
let cached: Promise<PreparedUniverse> | null = null;

export function getPreparedUniverse(): Promise<PreparedUniverse> {
  cached ??= loadPreparedUniverse().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}
