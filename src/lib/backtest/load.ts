import { CSV_1H_DIR, CSV_2H_DIR, CSV_4H_DIR, CSV_PANEL_DIR, readCsvPanels } from "./csvPanel";
import { fetchRemoteCsvPanels } from "./marketRemote";
import { marketBaseUrl } from "./marketStore";
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
  type PanelSnapshot,
} from "./panelCache";
import { readLiveBook } from "./liveBook";
import {
  DEFAULT_SMALL_FUND_POOL,
  membershipForPool,
  tickersForPool,
  type SmallFundPoolId,
} from "./smallFundPools";
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
export async function fetchSnapshot(): Promise<PanelSnapshot> {
  throw new Error("已停用数据库拉面板。行情读 VPS CSV（MARKET_DATA_BASE_URL）。");
}

/** 标普/纳指实验室只认本地面板缓存，不再回落数据库。 */
async function getSnapshot(): Promise<PanelSnapshot> {
  const hit = readSnapshot(PANEL_CACHE_PATH);
  if (hit) {
    console.log(
      `[panel] 缓存命中 ${mb(snapshotSize(PANEL_CACHE_PATH))}` +
        ` 拉取于 ${hit.fetchedAt.slice(0, 16).replace("T", " ")}`,
    );
    return hit;
  }
  throw new Error(
    `面板缓存缺失：${PANEL_CACHE_PATH}。标普/纳指实验室需要这份缓存；Small Fund 走 VPS CSV。`,
  );
}

export type SmallFundSource = "csv";

export function smallFundSource(): SmallFundSource {
  return "csv";
}

const CSV_GAP = new Set(["SKHY", "SPCX"]);

/** 允许缺几只脏票，但不接受「只有 195、缺一整批扩池」。 */
export function coversPool(panels: readonly { ticker: string }[], wanted: readonly string[]): boolean {
  if (panels.length === 0) return false;
  const have = new Set(panels.map((p) => p.ticker));
  let missing = 0;
  for (const ticker of wanted) {
    if (CSV_GAP.has(ticker)) continue;
    if (!have.has(ticker)) missing += 1;
  }
  return missing <= 8;
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

const smallFundPanels = new Map<string, Promise<PanelBars[]>>();

function poolTickers(poolId: SmallFundPoolId): readonly string[] {
  return tickersForPool(poolId, poolId === "sf-live" ? readLiveBook() : []);
}

async function readCsvForTimeframe(timeframe: Timeframe, wanted: readonly string[]): Promise<PanelBars[]> {
  const tf = timeframe === "1d" || timeframe === "4h" || timeframe === "2h" || timeframe === "1h" ? timeframe : "1d";
  if (marketBaseUrl()) {
    const remote = await fetchRemoteCsvPanels(tf, wanted);
    const panels = tf === "1d" ? remote : remote.filter((panel) => panel.ticker !== "SPCX");
    if (coversPool(panels, wanted)) return panels;
  }
  const local =
    timeframe === "1d"
      ? readCsvPanels(CSV_PANEL_DIR, wanted)
      : readCsvPanels(
          { "4h": CSV_4H_DIR, "2h": CSV_2H_DIR, "1h": CSV_1H_DIR }[timeframe],
          wanted,
        ).filter((panel) => panel.ticker !== "SPCX");
  return local;
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
    const label = timeframe === "1d" ? "CSV" : timeframe.toUpperCase();
    const csv = await readCsvForTimeframe(timeframe, wanted);
    if (coversPool(csv, wanted)) {
      console.log(`[smallfund] ${label} ${csv.length} 只  pool=${poolId}`);
      return csv;
    }
    throw new Error(
      `Small Fund ${label} 未覆盖当前池（${csv.length}/${wanted.length}）。` +
        `先同步 VPS CSV，或给 Vercel 配 MARKET_DATA_BASE_URL。`,
    );
  })();

  smallFundPanels.set(key, task);
  task.catch(() => smallFundPanels.delete(key));
  return task;
}

async function loadSmallFundUniverse(
  timeframe: Timeframe = "1d",
  poolId: SmallFundPoolId = DEFAULT_SMALL_FUND_POOL,
): Promise<PreparedUniverse> {
  const scale = await requireRpsScale();
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
