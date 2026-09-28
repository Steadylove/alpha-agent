import "./load-env";

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PANEL_CACHE_PATH, readSnapshot, snapshotSize } from "@/lib/backtest/panelCache";

/**
 * 把已上传的面板快照下载到本地缓存，供标普 / 纳指实验室使用。
 * 缺缓存时不会转向其他存储服务；Small Fund 使用独立的本地 / VPS CSV。
 *
 * 只认一个 URL 而不绑定某家对象存储：R2、Vercel Blob、S3、GitHub Release
 * 都能给出可下载地址，用 fetch 就够，不必为此引入任何 SDK。
 *
 * 用法:
 *   PANEL_SNAPSHOT_URL=https://... npx tsx scripts/fetch-panel-cache.ts
 *
 * 刷新流程：本地 `npm run panel:cache` 重建 → 上传到存储 → 在使用快照的环境下载。
 */

const STAGING_PATH = `${PANEL_CACHE_PATH}.download`;

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)}MB`;

async function main() {
  // 已有可用缓存就不动：本地开发反复构建不该每次重下 72MB
  const existing = readSnapshot(PANEL_CACHE_PATH);
  if (existing) {
    console.log(
      `[panel] 已有缓存 ${mb(snapshotSize(PANEL_CACHE_PATH))}` +
        ` 拉取于 ${existing.fetchedAt.slice(0, 16).replace("T", " ")}，跳过下载`,
    );
    return;
  }

  const url = process.env.PANEL_SNAPSHOT_URL;
  if (!url) {
    console.warn(
      "[panel] 无缓存且未设置 PANEL_SNAPSHOT_URL，跳过。" +
        "标普/纳指实验室没有面板快照；Small Fund 仍读本地 / VPS CSV。" +
        "需要完整面板时再配快照地址，或本地 npm run panel:cache。",
    );
    return;
  }

  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status} ${res.statusText}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  mkdirSync(path.dirname(PANEL_CACHE_PATH), { recursive: true });
  writeFileSync(STAGING_PATH, bytes);

  // 先落暂存再校验：截断或版本不符时 readSnapshot 返回 null，
  // 此时决不能覆盖正式路径——半个面板比没有面板更难排查。
  const snapshot = readSnapshot(STAGING_PATH);
  if (!snapshot || snapshot.panels.length === 0) {
    rmSync(STAGING_PATH, { force: true });
    throw new Error(
      `下载的 ${mb(bytes.length)} 无法解析为有效快照（截断、格式版本不符或内容为空）`,
    );
  }

  renameSync(STAGING_PATH, PANEL_CACHE_PATH);
  console.log(
    `[panel] 已下载 ${mb(bytes.length)} ${Date.now() - t0}ms` +
      `  ${snapshot.panels.length} 只  拉取于 ${snapshot.fetchedAt.slice(0, 16).replace("T", " ")}`,
  );
}

main().catch((error) => {
  console.error(`[panel] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
