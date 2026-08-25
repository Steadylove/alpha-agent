import { CSV_2H_DIR, CSV_4H_DIR, CSV_PANEL_DIR, readCsvPanels } from "./csvPanel";
import {
  prepareUniverse,
  type MembershipSpan,
  type PreparedUniverse,
  type Timeframe,
} from "./engine";
import { unpackPanel, type PanelBars } from "./panel";
import {
  PANEL_CACHE_PATH,
  readSnapshot,
  snapshotSize,
  writeSnapshot,
  type PanelSnapshot,
} from "./panelCache";
import {
  SMALL_FUND_MEMBERSHIP_START,
  SMALL_FUND_UNIVERSE,
} from "./smallFundUniverse";

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
  SMALLFUND: { label: "Small Fund 200", sources: ["SMALLFUND"] },
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
  const { getPrisma } = await import("@/lib/db/prisma");
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

  /*
   * 部署环境不许回落数据库。
   *
   * 那里文件系统只读，落盘必然失败，于是每个新实例冷启动都要重新下载完整面板
   * （72MB）。Neon 免费档 5GB/月按这个用法约 70 次冷启动就见底，实测确实被打满，
   * 连带把仪表盘的额度一起吃掉。面板必须作为构建产物随部署带上。
   */
  if (process.env.VERCEL) {
    throw new Error(
      `面板缓存缺失：${PANEL_CACHE_PATH}。` +
        "部署环境不从数据库拉面板（每次冷启动 72MB 会打满配额），" +
        "请把快照作为构建产物打进函数包。",
    );
  }

  const t0 = Date.now();
  const fresh = await fetchSnapshot();

  // 空面板一律当失败：读降级（见 lib/db/degrade）会把配额耗尽变成空数组，
  // 而 getPreparedUniverse 会把解析成功的结果一直缓存下去——
  // 不在这里拦住，实验室就会静默显示一个 0 只标的的空池，且直到实例回收都不恢复。
  if (fresh.panels.length === 0) {
    throw new Error("数据库返回空面板：数据源不可用或配额耗尽，未落盘。");
  }

  const written = writeSnapshot(PANEL_CACHE_PATH, fresh);
  console.log(
    `[panel] 从数据库拉取 ${fresh.panels.length} 只 ${Date.now() - t0}ms` +
      `，${written ? `已写入缓存 ${mb(snapshotSize(PANEL_CACHE_PATH))}` : "缓存写入失败（目录只读），本次不落盘"}`,
  );
  return fresh;
}

/**
 * Small Fund 数据源。
 *
 * - `csv`（默认）：读 `data/smallfund/*.csv`，不碰数据库。额度耗尽时的兜底。
 * - `db`：从 BacktestPanel 按 ticker 过滤。额度恢复后切这条。
 * - `auto`：CSV 有文件用 CSV，否则回落数据库。
 */
export type SmallFundSource = "csv" | "db" | "auto";

export function smallFundSource(): SmallFundSource {
  const raw = (process.env.SMALLFUND_SOURCE ?? "csv").toLowerCase();
  return raw === "db" || raw === "auto" ? raw : "csv";
}

function prepareSmallFund(panels: PanelBars[]): PreparedUniverse {
  const membership = new Map(
    panels.map((p) => [p.ticker, [{ start: SMALL_FUND_MEMBERSHIP_START, end: null }]]),
  );
  return prepareUniverse(panels, membership);
}

async function loadSmallFundFromDb(): Promise<PanelBars[]> {
  const snapshot = await getSnapshot();
  const wanted = new Set(SMALL_FUND_UNIVERSE);
  const panels: PanelBars[] = [];
  for (const row of snapshot.panels) {
    if (!wanted.has(row.ticker)) continue;
    panels.push(unpackPanel(row));
  }
  return panels;
}

async function loadSmallFundUniverse(timeframe: Timeframe = "1d"): Promise<PreparedUniverse> {
  if (timeframe === "4h" || timeframe === "2h") {
    const dir = timeframe === "2h" ? CSV_2H_DIR : CSV_4H_DIR;
    const label = timeframe === "2h" ? "2H" : "4H";
    const cmd = timeframe === "2h" ? "smallfund:fetch-2h" : "smallfund:fetch-4h";
    const csv = readCsvPanels(dir, SMALL_FUND_UNIVERSE).filter((panel) => panel.ticker !== "SPCX");
    if (csv.length === 0) {
      throw new Error(`Small Fund ${label} CSV 为空：${dir}。先跑 npm run ${cmd}。`);
    }
    console.log(`[smallfund] ${label} CSV ${csv.length} 只  ${dir}`);
    return prepareSmallFund(csv);
  }

  const source = smallFundSource();

  if (source === "csv" || source === "auto") {
    const csv = readCsvPanels(CSV_PANEL_DIR, SMALL_FUND_UNIVERSE);
    if (csv.length > 0) {
      console.log(`[smallfund] CSV ${csv.length} 只  ${CSV_PANEL_DIR}`);
      return prepareSmallFund(csv);
    }
    if (source === "csv") {
      throw new Error(
        `Small Fund CSV 为空：${CSV_PANEL_DIR}。先跑 npm run smallfund:fetch，或设 SMALLFUND_SOURCE=db。`,
      );
    }
  }

  const db = await loadSmallFundFromDb();
  if (db.length === 0) {
    throw new Error(
      "Small Fund 数据库面板为空。额度恢复后跑 npm run smallfund:import，或先用 CSV：npm run smallfund:fetch。",
    );
  }
  console.log(`[smallfund] 数据库 ${db.length} 只`);
  return prepareSmallFund(db);
}

export async function loadPreparedUniverse(
  index: IndexKey = DEFAULT_INDEX,
  timeframe: Timeframe = "1d",
): Promise<PreparedUniverse> {
  if (index === "SMALLFUND") return loadSmallFundUniverse(timeframe);

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
const cached = new Map<string, Promise<PreparedUniverse>>();

export function getPreparedUniverse(
  index: IndexKey = DEFAULT_INDEX,
  timeframe: Timeframe = "1d",
): Promise<PreparedUniverse> {
  const key = `${index}:${timeframe}`;
  const hit = cached.get(key);
  if (hit) return hit;

  const task = loadPreparedUniverse(index, timeframe).catch((error) => {
    cached.delete(key);
    throw error;
  });
  cached.set(key, task);
  return task;
}
