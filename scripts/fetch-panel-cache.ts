import "dotenv/config";

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PANEL_CACHE_PATH, readSnapshot, snapshotSize } from "@/lib/backtest/panelCache";

/**
 * 把面板快照取到本地缓存路径，供 `next build` 打进函数包。
 *
 * 为什么要有这一步：部署环境文件系统只读，运行时拿不到缓存就会回落数据库，
 * 每个冷启动实例都要下载完整面板（72MB）——Neon 免费档按这个用法约 70 次就见底。
 * 所以面板必须在构建时就位，成为部署产物的一部分（见 next.config.ts 的
 * outputFileTracingIncludes）。
 *
 * 只认一个 URL 而不绑定某家对象存储：R2、Vercel Blob、S3、GitHub Release
 * 都能给出可下载地址，用 fetch 就够，不必为此引入任何 SDK。
 *
 * 用法:
 *   PANEL_SNAPSHOT_URL=https://... npx tsx scripts/fetch-panel-cache.ts
 *
 * 刷新流程：本地 `npm run panel:cache` 重建 → 上传到你的存储 → 重新部署。
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
    // 部署环境缺快照等于上线一个空实验室，宁可让构建失败
    if (process.env.VERCEL) {
      throw new Error(
        "未设置 PANEL_SNAPSHOT_URL，构建产物里不会有面板快照，" +
          "实验室上线后取不到数据。请在项目环境变量里配置快照下载地址。",
      );
    }
    console.log("[panel] 无缓存且未设置 PANEL_SNAPSHOT_URL，跳过（本地可用 npm run panel:cache 重建）");
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
