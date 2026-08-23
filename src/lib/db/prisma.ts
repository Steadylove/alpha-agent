import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export function getPrisma() {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for database operations.");
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    // pg 默认 0 = 永远等。Neon 抖一下或连接池打满就会无限挂住而不报错，
    // 排查时表现为「卡住了」而非任何错误日志。
    connectionTimeoutMillis: 10_000,
    // 兜住真正跑飞的查询。设得宽松是因为回测面板一次要读约 47MB，
    // 正常耗时 13~18 秒，设紧了会把正常查询一起杀掉。
    statement_timeout: 120_000,
  });
  const prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

  // 生产环境同样要缓存。原先只在非生产写入，导致线上每次调用都新建一个
  // PrismaClient 与 pg 连接池（默认 10 条），每请求一个池，Neon 连接数很快
  // 打满，后续连接排队又没有超时。常见写法里的 NODE_ENV 判断是为了让开发
  // 环境的热重载不要反复建池，不是为了在生产环境跳过缓存。
  globalForPrisma.prisma = prisma;

  return prisma;
}
