/**
 * 数据库整体不可达时，让只读查询退化成空结果，而不是把页面打成 500。
 *
 * 存在的理由：看板页的数据全部来自每日任务写入的派生表，而各加载器已经写了
 * 「查不到就返回 empty」的守卫（`if (!newest) return empty`）。于是只要把
 * 「库连不上」这一类错误在读操作上转成空值，7 个看板页就能自己渲染成
 * 「数据生成中」，无需逐页改。
 *
 * 只对读操作生效。写操作必须继续抛错，否则每日任务会把「没写进去」误判成成功。
 */

/** Prisma 自身的连接层错误码：连不上、认证失败、超时、连接池耗尽。 */
const UNAVAILABLE_PRISMA_CODES = new Set([
  "P1000",
  "P1001",
  "P1002",
  "P1008",
  "P1010",
  "P1017",
  "P2024",
]);

/**
 * Postgres SQLSTATE 前缀：08 连接异常、53 资源不足（含 Neon 配额耗尽的 53000
 * 与连接数打满的 53300）、57P0x 管理员关闭。
 *
 * 匹配的是 Prisma 错误信息里 "Code: `53000`" 这种固定格式，而不是全文搜数字，
 * 否则消息里任何一个恰好长得像的数字都会误判成不可用。
 */
const UNAVAILABLE_SQLSTATE = /Code: [`"']?(08[\w]{3}|53[\d]{3}|57P0[123])/;

/** 适配器层抛出的 socket 错误不带 Prisma 码，只能认文本。 */
const UNAVAILABLE_TEXT =
  /data transfer quota|too many connections|Can't reach database server|Connection terminated|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i;

export function isDbUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && UNAVAILABLE_PRISMA_CODES.has(code)) return true;

  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;

  return UNAVAILABLE_SQLSTATE.test(message) || UNAVAILABLE_TEXT.test(message);
}

/**
 * 各只读操作对应的空结果。不在表里的操作（写操作、`findFirstOrThrow`、
 * `aggregate` 等）一律原样抛出：写操作不能假装成功，`OrThrow` 的契约就是抛，
 * 而聚合的空值形状因调用而异，造不出通用的。
 */
const EMPTY_RESULT: Record<string, unknown> = {
  findMany: [],
  findFirst: null,
  findUnique: null,
  count: 0,
};

/**
 * 读操作的降级包装。命中「库不可达」且该操作有对应空值时返回空值，其余原样抛出。
 */
export async function readOrEmpty<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isDbUnavailable(error) || !(operation in EMPTY_RESULT)) throw error;
    return EMPTY_RESULT[operation] as T;
  }
}
