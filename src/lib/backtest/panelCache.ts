import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deserialize, serialize } from "node:v8";

/**
 * 历史面板的本地落盘缓存。
 *
 * 这批数据是不变的存量行情：整块读走、从不按条件筛选，本质是文件而非数据库内容。
 * 放在云 Postgres 里意味着每跑一次回测就重新下载完整历史——47MB × 每次调参。
 * Neon 免费档 5GB/月的出站额度按这个用法只够约 106 次，实测确实被打满并挂起。
 *
 * 落盘后本地开发的出站流量降到「首次一次」，冷启动也从 17 秒（其中 13.5 秒纯粹
 * 在等传输）降到读本地文件的量级。
 *
 * 用 `v8.serialize` 而非自定义容器格式：它原生支持 Uint8Array 与 Date，零依赖。
 * 代价是格式不保证跨 Node 大版本稳定，因此读取失败一律当作未命中重新拉取。
 */

/** 缓存结构变化时递增，旧文件会被当作未命中。2: 加 open 列（顶背离要实体上沿）。 */
const VERSION = 2;

/** 与 `prisma.backtestPanel` 的选取列一致。 */
export type PanelRow = {
  ticker: string;
  days: Uint8Array;
  high: Uint8Array;
  low: Uint8Array;
  close: Uint8Array;
  volume: Uint8Array | null;
  open: Uint8Array | null;
};

/** 与 `prisma.indexMembership` 的选取列一致，含 `index` 以便本地按池筛选。 */
export type MemberRow = {
  ticker: string;
  index: string;
  startDate: Date;
  endDate: Date | null;
};

export type PanelSnapshot = {
  /** 拉取时刻，用于判断缓存有多旧 */
  fetchedAt: string;
  panels: PanelRow[];
  membership: MemberRow[];
};

export const PANEL_CACHE_PATH = path.join(/*turbopackIgnore: true*/ process.cwd(), ".cache", "backtest-panel.v8");

export type PanelHydrateMode = "reuse" | "url" | "database" | "skip";

/**
 * 构建时如何把面板落到 `.cache`。
 *
 * 顺序：本地文件 → `PANEL_SNAPSHOT_URL` → `DATABASE_URL`。
 * 部署环境没有前两样时必须走数据库，不能再警告完跳过——后面的 `rps:scale`
 * 会在 `VERCEL` 下拒绝回落数据库，构建必挂。
 */
export function resolvePanelHydrate(opts: {
  hasCache: boolean;
  snapshotUrl: string | undefined;
  hasDatabaseUrl: boolean;
}): PanelHydrateMode {
  if (opts.hasCache) return "reuse";
  if (opts.snapshotUrl) return "url";
  if (opts.hasDatabaseUrl) return "database";
  return "skip";
}

/** 命中返回快照，文件不存在、版本不符或解析失败一律返回 null。 */
export function readSnapshot(file: string): PanelSnapshot | null {
  if (!existsSync(file)) return null;

  try {
    const payload = deserialize(readFileSync(file)) as { version?: number } & PanelSnapshot;
    if (payload.version !== VERSION) return null;
    if (!Array.isArray(payload.panels) || !Array.isArray(payload.membership)) return null;
    return { fetchedAt: payload.fetchedAt, panels: payload.panels, membership: payload.membership };
  } catch {
    return null;
  }
}

/**
 * 写入缓存，返回是否成功。
 *
 * 写失败不抛：Vercel 之类的部署环境工作目录只读，那里本就不该依赖磁盘缓存
 * （函数实例的文件系统是临时的，进程内缓存已经覆盖同一实例的重复请求）。
 * 这种环境下退回原有行为即可，不该让一次回测直接失败。
 */
export function writeSnapshot(file: string, snapshot: PanelSnapshot): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, serialize({ version: VERSION, ...snapshot }));
    return true;
  } catch {
    return false;
  }
}

/** 缓存文件字节数，不存在则为 0。 */
export function snapshotSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
