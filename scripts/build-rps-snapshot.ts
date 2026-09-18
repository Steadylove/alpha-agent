import "dotenv/config";
import { buildAndStoreSignalRps } from "@/lib/backtest/buildSignalRps";

// Vercel 始终取 VPS 动态快照，不再在构建阶段固化排名或全量下载行情。
if (process.env.VERCEL) {
  console.log("[rps] Vercel 运行时读取 VPS 动态快照，跳过构建期排名。");
} else {
  buildAndStoreSignalRps().catch(error => { console.error(error); process.exitCode = 1; });
}
