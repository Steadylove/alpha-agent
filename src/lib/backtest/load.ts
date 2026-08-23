import { getPrisma } from "@/lib/db/prisma";

import { prepareUniverse, type MembershipSpan, type PreparedUniverse } from "./engine";
import { unpackPanel, type PanelBars } from "./panel";
import {
  PANEL_CACHE_PATH,
  readSnapshot,
  snapshotSize,
  writeSnapshot,
  type PanelSnapshot,
} from "./panelCache";

/**
 * 可选的标的池。`sources` 是 IndexMembership.index 里要取的指数，多于一个即并集。
 *
 * 并集不需要合并重叠区间：成分资格判定用的是 `spans.some(...)`（见 engine.inSpan），
 * 同一标的在两个指数里各有一段时天然取或，重复段无害。
 */
export const INDEXES = {
  UNION: { label: "标普 ∪ 纳斯达克", sources: ["SP500", "NDX100"] },
  SP500: { label: "标普 500", sources: ["SP500"] },
  NDX100: { label: "纳斯达克 100", sources: ["NDX100"] },
} as const;

export type IndexKey = keyof typeof INDEXES;

export const DEFAULT_INDEX: IndexKey = "UNION";

const iso = (d: Date) => d.toISOString().slice(0, 10);

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/**
 * 一次性把面板与全部成分区间取回。
 *
 * 面板查询本来就没有 where 条件（要哪些标的是靠成分区间在本地筛的），成分表也小，
 * 所以整个快照与选哪个池无关——一份缓存服务三个池子。
 */
async function fetchSnapshot(): Promise<PanelSnapshot> {
  const prisma = getPrisma();

  const [panels, membership] = await Promise.all([
    prisma.backtestPanel.findMany({
      select: {
        ticker: true,
        days: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        open: true,
      },
    }),
    prisma.indexMembership.findMany({
      where: { hasBars: true },
      select: { ticker: true, index: true, startDate: true, endDate: true },
    }),
  ]);

  return { fetchedAt: new Date().toISOString(), panels, membership };
}

/**
 * 优先读本地缓存，未命中才走数据库并落盘。
 *
 * 置 `BACKTEST_PANEL_REFRESH=1` 可强制重新拉取，日线回填之后用它刷新。
 */
async function getSnapshot(): Promise<PanelSnapshot> {
  if (process.env.BACKTEST_PANEL_REFRESH !== "1") {
    const hit = readSnapshot(PANEL_CACHE_PATH);
    if (hit) {
      console.log(
        `[panel] 缓存命中 ${mb(snapshotSize(PANEL_CACHE_PATH))}` +
          ` 拉取于 ${hit.fetchedAt.slice(0, 16).replace("T", " ")}，未访问数据库`,
      );
      return hit;
    }
  }

  const t0 = Date.now();
  const fresh = await fetchSnapshot();
  const written = writeSnapshot(PANEL_CACHE_PATH, fresh);
  console.log(
    `[panel] 从数据库拉取 ${fresh.panels.length} 只 ${Date.now() - t0}ms` +
      `，${written ? `已写入缓存 ${mb(snapshotSize(PANEL_CACHE_PATH))}` : "缓存写入失败（目录只读），本次不落盘"}`,
  );
  return fresh;
}

export async function loadPreparedUniverse(
  index: IndexKey = DEFAULT_INDEX,
): Promise<PreparedUniverse> {
  const snapshot = await getSnapshot();
  const sources = new Set<string>(INDEXES[index].sources);

  const membership = new Map<string, MembershipSpan[]>();
  for (const s of snapshot.membership) {
    if (!sources.has(s.index)) continue;
    const list = membership.get(s.ticker) ?? [];
    list.push({ start: iso(s.startDate), end: s.endDate ? iso(s.endDate) : null });
    membership.set(s.ticker, list);
  }

  // 没有成分区间的标的进不了任何一天的截面，不必载入。
  // SPY 也在这里被自然排除：它不是任何指数的成分，没有 IndexMembership 行。
  const panels: PanelBars[] = [];
  for (const row of snapshot.panels) {
    const panel = unpackPanel(row);
    if (membership.has(panel.ticker)) panels.push(panel);
  }

  return prepareUniverse(panels, membership);
}

/**
 * 进程内缓存，按指数分开。准备段只依赖行情与成分资格，参数变化不影响，
 * 而它是整条链路里最贵的一步（冷启动十几秒），不能每次请求都重算。
 */
const cached = new Map<IndexKey, Promise<PreparedUniverse>>();

export function getPreparedUniverse(index: IndexKey = DEFAULT_INDEX): Promise<PreparedUniverse> {
  const hit = cached.get(index);
  if (hit) return hit;

  const task = loadPreparedUniverse(index).catch((error) => {
    cached.delete(index);
    throw error;
  });
  cached.set(index, task);
  return task;
}
