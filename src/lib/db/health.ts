import { isDbUnavailable } from "@/lib/db/degrade";
import { getPrisma } from "@/lib/db/prisma";

/**
 * 数据库可达性探测，供页面顶部的降级提示条使用。
 *
 * 不复用读操作的降级结果：布局先于页面内容渲染，那时还没有任何查询发生过，
 * 拿不到降级状态。所以这里自己发一条最小查询，结果按进程内缓存复用。
 */

const TTL_MS = 15_000;

let checkedAt = 0;
let reachable = true;
let inflight: Promise<boolean> | null = null;

async function probe(): Promise<boolean> {
  try {
    // 裸 SQL 不经过 $allModels 扩展，因此库不可用时这里会照常抛错
    await getPrisma().$queryRawUnsafe("SELECT 1");
    return true;
  } catch (error) {
    if (isDbUnavailable(error)) return false;
    // 其他错误说明库是通的，只是这条查询本身有问题
    return true;
  }
}

export async function isDbReachable(): Promise<boolean> {
  if (Date.now() - checkedAt < TTL_MS) return reachable;
  // 同一时刻的并发请求共用一次探测
  inflight ??= probe().then((ok) => {
    reachable = ok;
    checkedAt = Date.now();
    inflight = null;
    return ok;
  });
  return inflight;
}
