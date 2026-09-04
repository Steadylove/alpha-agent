/**
 * Neon 免费档把计算和出站算在同一份额度里。本地 .env 里的 DATABASE_URL
 * 就是线上那条，调试时随手连会把额度打给开发机，线上看板一起挂。
 *
 * 默认：只有生产 / Vercel 才连远程库。本地要写库或对照线上数据时，
 * 命令前加 ALLOW_DB=1。
 */

export function remoteDbEnabled(): boolean {
  if (process.env.ALLOW_DB === "1") return true;
  if (process.env.ALLOW_DB === "0") return false;
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL) && remoteDbEnabled();
}
