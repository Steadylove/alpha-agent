import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 外生 RPS 标尺：拿标普 500 当日成分的动量分分布当尺子，别的池子把自己的分数
 * 插进去取百分位。
 *
 * 为什么不继续在自己池内排名：池内排名的值依赖池子构成，往 Small Fund 加减票会
 * 让**留下来那些票**的 RPS 跟着动（实测加减 10% 的票平均漂 0.8 分、5% 的买点
 * 出现或消失；若加进来的一批风格集中，漂到 2 分）。换成外生标尺后，加票只影响
 * 「哪些票可交易」，不再影响任何历史 RPS 值，回测因此可复现。
 *
 * 附带两个好处：门槛数字有了绝对含义（50 就是「强于市场一半」），且跨池可比。
 *
 * 收益上两种口径实测基本中性——公平重搜后整个参数面的中位数只差 0.5 个点，
 * 所以换它是为了上面那些工程性质，不是为了更赚钱。
 *
 * 为什么落成文件而不是运行时算：标普面板是 73MB 的数据库快照，而 Small Fund
 * 现在只读仓库里的 CSV。让 SF 挂上那个依赖会毁掉它的自包含性，Vercel 上更没有。
 * 分布本身只需要分位切点，压到 99 个数一天，全窗口约 1MB。
 */

export const RPS_SCALE_PATH = path.join(process.cwd(), "data", "rps-scale-spx.json");

/** 切点数量。99 个点即每 1 个分位一个，查询用线性插值，误差不到 1 分位。 */
export const SCALE_BUCKETS = 99;

export type RpsScaleFile = {
  generatedAt: string;
  /** 标尺来自哪个池，记进文件以免日后认不出 */
  index: string;
  buckets: number;
  /** 交易日升序 */
  dates: string[];
  /** 与 dates 一一对应：当日成分的 alphaScore 升序分位切点 */
  cuts: number[][];
  /** 当日进入排名的标的数，用于判断某天的标尺是否可信 */
  counts: number[];
};

export type RpsScale = {
  generatedAt: string;
  index: string;
  /** 覆盖到的交易日升序，用于判断标尺是否落后于行情 */
  dates: readonly string[];
  at: Map<string, Float64Array>;
};

/**
 * 分数在标尺上的百分位，值域 [1, 99]，与 `percentileRank` 的夹紧口径一致。
 *
 * 切点之间线性插值。落在两端之外就取端值——尺子只有 99 个点，比 p1 还弱或比 p99
 * 还强的都归到边界，反正门槛不会设在那里。
 */
export function scalePercentile(cuts: Float64Array, score: number): number {
  const n = cuts.length;
  if (n === 0 || !Number.isFinite(score)) return 0;
  if (score <= cuts[0]) return 1;
  if (score >= cuts[n - 1]) return 99;

  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] <= score) lo = mid;
    else hi = mid;
  }
  const span = cuts[lo + 1] - cuts[lo];
  const frac = span > 0 ? (score - cuts[lo]) / span : 0;
  // cuts[k] 是第 (k+1) 个分位，故基准是 lo+1
  return Math.min(99, Math.max(1, lo + 1 + frac));
}

/** 从升序数组取分位切点。最近邻足够——查询侧还会插值。 */
export function quantileCuts(sorted: ArrayLike<number>, buckets = SCALE_BUCKETS): number[] {
  const n = sorted.length;
  const out: number[] = [];
  for (let k = 1; k <= buckets; k += 1) {
    const idx = Math.min(n - 1, Math.max(0, Math.round(((k / (buckets + 1)) * (n - 1))))); 
    out.push(sorted[idx]);
  }
  return out;
}

let cached: RpsScale | null = null;

export function parseScaleFile(file: RpsScaleFile): RpsScale {
  const at = new Map<string, Float64Array>();
  file.dates.forEach((date, i) => {
    at.set(date, Float64Array.from(file.cuts[i]));
  });
  return { generatedAt: file.generatedAt, index: file.index, dates: file.dates, at };
}

export function readRpsScale(): RpsScale | null {
  if (cached) return cached;
  if (!existsSync(RPS_SCALE_PATH)) return null;

  cached = parseScaleFile(JSON.parse(readFileSync(RPS_SCALE_PATH, "utf8")) as RpsScaleFile);
  return cached;
}

export async function requireRpsScale(): Promise<RpsScale> {
  const local = readRpsScale();
  if (local) return local;

  const { remoteDbEnabled } = await import("@/lib/db/remote");
  if (remoteDbEnabled() && process.env.DATABASE_URL) {
    const { getPrisma } = await import("@/lib/db/prisma");
    const row = await getPrisma().rpsScale.findUnique({ where: { id: "spx" } });
    if (row?.payload && typeof row.payload === "object") {
      cached = parseScaleFile(row.payload as RpsScaleFile);
      return cached;
    }
  }

  throw new Error(
    `RPS 标尺缺失：${RPS_SCALE_PATH}。跑 npm run rps:scale 生成（需要标普面板缓存）。`,
  );
}
