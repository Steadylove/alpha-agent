/**
 * 库探测已废：运行时不连 Postgres。提示条视为可达，避免误报 Neon。
 */
export async function isDbReachable(): Promise<boolean> {
  return true;
}
