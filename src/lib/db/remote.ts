/**
 * 运行时不再连 Postgres / Neon。读和写一律走 VPS 文件（CSV / snapshots / desk）。
 */

export function remoteDbEnabled(): boolean {
  return false;
}

export function hasDatabase(): boolean {
  return false;
}
