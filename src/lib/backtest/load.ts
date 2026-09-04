import { CSV_1H_DIR, CSV_2H_DIR, CSV_4H_DIR, CSV_PANEL_DIR, readCsvPanels } from "./csvPanel";
import {
  DEFAULT_VEGAS,
  prepareUniverse,
  type DailyRpsTable,
  type MembershipSpan,
  type PreparedUniverse,
  type RpsSource,
  type Timeframe,
} from "./engine";
import { requireRpsScale, type RpsScale } from "./rpsScale";
import { unpackPanel, type PanelBars } from "./panel";
import {
  PANEL_CACHE_PATH,
  readSnapshot,
  snapshotSize,
  writeSnapshot,
  type PanelSnapshot,
} from "./panelCache";
import { readLiveBook } from "./liveBook";
import {
  DEFAULT_SMALL_FUND_POOL,
  membershipForPool,
  tickersForPool,
  type SmallFundPoolId,
} from "./smallFundPools";
import { SMALL_FUND_UNIVERSE } from "./smallFundUniverse";

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
  SMALLFUND: { label: "Small Fund", sources: ["SMALLFUND"] },
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

function prepareSmallFund(
  panels: PanelBars[],
  poolId: SmallFundPoolId,
  rpsSource: RpsSource,
): PreparedUniverse {
  const changes = poolId === "sf-live" ? readLiveBook() : [];
  const wanted = new Set(tickersForPool(poolId, changes));
  const subset = panels.filter((p) => wanted.has(p.ticker));
  return prepareUniverse(
    subset,
    membershipForPool(poolId, subset.map((p) => p.ticker), changes),
    DEFAULT_VEGAS,
    rpsSource,
  );
}

/**
 * 标尺落后于行情时必须炸掉，不能放过去。
 *
 * 未覆盖的日期在 `fillRps` 里 RPS 保持 0，而 0 会被入场闸门当成「回看未齐」挡掉，
 * 于是最新那几天的信号全部静默消失——正好是实盘最关心的几天。
 */
function assertScaleFresh(axis: readonly string[], scale: RpsScale): void {
  const lastBar = axis.at(-1);
  const lastCut = scale.dates.at(-1);
  if (!lastBar || !lastCut || lastBar <= lastCut) return;
  throw new Error(
    `RPS 标尺只到 ${lastCut}，行情已到 ${lastBar}，这中间的信号会拿不到 RPS。` +
      `跑 npm run rps:scale 重建标尺。`,
  );
}

/**
 * 把日线 universe 的 RPS 摊平到日线轴，供盘中周期取用。
 *
 * 停牌（该日无 bar）沿用上一个值，而「有 bar 但 RPS 为 0」（回看未齐、非成分）
 * 照实记 0——后者必须挡住入场，不能被前值填掉。
 */
function dailyRpsTable(daily: PreparedUniverse): DailyRpsTable {
  const byTicker = new Map<string, Float32Array>();
  for (const sym of daily.symbols) {
    const arr = new Float32Array(daily.axis.length);
    let last = 0;
    let c = 0;
    for (let d = 0; d < daily.axis.length; d += 1) {
      if (c < sym.axisIndex.length && sym.axisIndex[c] === d) {
        last = sym.rps[c];
        c += 1;
      }
      arr[d] = last;
    }
    byTicker.set(sym.ticker, arr);
  }
  return { dates: daily.axis, byTicker };
}

async function loadSmallFundFromDb(poolId: SmallFundPoolId = DEFAULT_SMALL_FUND_POOL): Promise<PanelBars[]> {
  const snapshot = await getSnapshot();
  const wanted = new Set(poolTickers(poolId));
  const panels: PanelBars[] = [];
  for (const row of snapshot.panels) {
    if (!wanted.has(row.ticker)) continue;
    panels.push(unpackPanel(row));
  }
  return panels;
}

const smallFundPanels = new Map<string, Promise<PanelBars[]>>();

function poolTickers(poolId: SmallFundPoolId): readonly string[] {
  return tickersForPool(poolId, poolId === "sf-live" ? readLiveBook() : []);
}

async function loadSmallFundPanels(
  timeframe: Timeframe,
  poolId: SmallFundPoolId = DEFAULT_SMALL_FUND_POOL,
): Promise<PanelBars[]> {
  const key = `${timeframe}:${poolId}`;
  const hit = smallFundPanels.get(key);
  if (hit) return hit;

  const task = (async () => {
    const wanted = poolTickers(poolId);
    if (timeframe === "4h" || timeframe === "2h" || timeframe === "1h") {
      const dir = { "4h": CSV_4H_DIR, "2h": CSV_2H_DIR, "1h": CSV_1H_DIR }[timeframe];
      const label = timeframe.toUpperCase();
      const cmd = `smallfund:fetch-${timeframe}`;
      const csv = readCsvPanels(dir, wanted).filter((panel) => panel.ticker !== "SPCX");
      if (csv.length === 0) {
        throw new Error(`Small Fund ${label} CSV 为空：${dir}。先跑 npm run ${cmd}。`);
      }
      console.log(`[smallfund] ${label} CSV ${csv.length} 只  ${dir}  pool=${poolId}`);
      return csv;
    }

    const source = smallFundSource();
    if (source === "csv" || source === "auto") {
      const csv = readCsvPanels(CSV_PANEL_DIR, wanted);
      if (csv.length > 0) {
        console.log(`[smallfund] CSV ${csv.length} 只  ${CSV_PANEL_DIR}  pool=${poolId}`);
        return csv;
      }
      if (source === "csv") {
        throw new Error(
          `Small Fund CSV 为空：${CSV_PANEL_DIR}。先跑 npm run smallfund:fetch，或设 SMALLFUND_SOURCE=db。`,
        );
      }
    }

    const db = await loadSmallFundFromDb(poolId);
    if (db.length === 0) {
      throw new Error(
        "Small Fund 数据库面板为空。额度恢复后跑 npm run smallfund:import，或先用 CSV：npm run smallfund:fetch。",
      );
    }
    console.log(`[smallfund] 数据库 ${db.length} 只  pool=${poolId}`);
    return db;
  })();

  smallFundPanels.set(key, task);
  task.catch(() => smallFundPanels.delete(key));
  return task;
}

async function loadSmallFundUniverse(
  timeframe: Timeframe = "1d",
  poolId: SmallFundPoolId = DEFAULT_SMALL_FUND_POOL,
): Promise<PreparedUniverse> {
  const scale = requireRpsScale();
  const panels = await loadSmallFundPanels(timeframe, poolId);
  if (timeframe === "1d") {
    const prepared = prepareSmallFund(panels, poolId, { kind: "scale", scale });
    assertScaleFresh(prepared.axis, scale);
    return prepared;
  }

  // 盘中周期的强度一律取日线值，理由见 DailyRpsTable
  const dailyPrepared = prepareSmallFund(await loadSmallFundPanels("1d", poolId), poolId, {
    kind: "scale",
    scale,
  });
  assertScaleFresh(dailyPrepared.axis, scale);
  const daily = dailyRpsTable(dailyPrepared);
  const prepared = prepareSmallFund(panels, poolId, { kind: "daily", daily });

  const missing = prepared.symbols.filter((s) => !daily.byTicker.has(s.ticker));
  if (missing.length > 0) {
    console.warn(
      `[smallfund] ${timeframe} 有 ${missing.length} 只票在日线里没有数据，` +
        `它们拿不到 RPS 因此永不入场：${missing.map((s) => s.ticker).join(" ")}`,
    );
  }
  return prepared;
}

export async function loadPreparedUniverse(
  index: IndexKey = DEFAULT_INDEX,
  timeframe: Timeframe = "1d",
  poolId: SmallFundPoolId = DEFAULT_SMALL_FUND_POOL,
): Promise<PreparedUniverse> {
  if (index === "SMALLFUND") return loadSmallFundUniverse(timeframe, poolId);

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
  poolId: SmallFundPoolId = DEFAULT_SMALL_FUND_POOL,
): Promise<PreparedUniverse> {
  const key = `${index}:${timeframe}:${index === "SMALLFUND" ? poolId : "-"}`;
  const hit = cached.get(key);
  if (hit) return hit;

  const task = loadPreparedUniverse(index, timeframe, poolId).catch((error) => {
    cached.delete(key);
    throw error;
  });
  cached.set(key, task);
  return task;
}

/** 活账本加减票后必须清掉准备结果，否则仍按旧成分扫信号。 */
export function invalidateSmallFundCache(): void {
  for (const key of [...cached.keys()]) {
    if (key.startsWith("SMALLFUND:")) cached.delete(key);
  }
  smallFundPanels.clear();
}
