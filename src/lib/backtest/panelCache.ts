import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deserialize, serialize } from "node:v8";

/**
 * 历史面板的本地落盘缓存。
 *
 * 完整行情与成分区间一次读取、按池在内存中筛选；复用文件避免每次调参
 * 重复下载同一份历史。已有缓存版本和二进制结构保持兼容。
 *
 * 用 `v8.serialize` 而非自定义容器格式：它原生支持 Uint8Array 与 Date，零依赖。
 * 代价是格式不保证跨 Node 大版本稳定，因此读取失败一律当作未命中重新拉取。
 */

/** 缓存结构变化时递增，旧文件会被当作未命中。2: 加 open 列（顶背离要实体上沿）。 */
const VERSION = 2;

/** 历史行情快照的二进制列；保持兼容已有 v8 缓存。 */
export type PanelRow = {
  ticker: string;
  days: Uint8Array;
  high: Uint8Array;
  low: Uint8Array;
  close: Uint8Array;
  volume: Uint8Array | null;
  open: Uint8Array | null;
};

/** 时点成分资格区间，含 `index` 以便本地按池筛选。 */
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
