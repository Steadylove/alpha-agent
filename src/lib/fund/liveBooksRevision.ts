import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { fetchMarketText } from "@/lib/backtest/marketRemote";
import { csvDir, marketBaseUrl, marketDataRoot, rpsScaleFile } from "@/lib/backtest/marketStore";
import { champOf } from "./champs";
import { DEFAULT_LOOKBACK_SLOTS } from "./lookbackLogic";

// 修改交易/信号算法时递增；参数变动由下面的配置哈希自动识别。
export const LIVE_BOOK_ENGINE_VERSION = 2;

export function liveStrategyKey(): string {
  return createHash("sha256").update(JSON.stringify({
    engine: LIVE_BOOK_ENGINE_VERSION,
    strategies: ["4h", "2h-broad"].map((id) => {
      const c = champOf(id);
      return { id, poolId: c.poolId, config: c.config, opts: { ...c.opts, slotPct: 1 / DEFAULT_LOOKBACK_SLOTS } };
    }),
  })).digest("hex");
}

/** 日更发布的清单是行情版本；本地旧布局用文件元数据识别更新。 */
export async function liveMarketRevision(): Promise<{ marketRevision: string; asOf: Partial<Record<"4h" | "2h", string>> }> {
  let manifest = "";
  if (marketBaseUrl()) {
    if (await fetchMarketText(".market-updating")) throw new Error("行情正在同步，请稍后重算");
    manifest = await fetchMarketText("MANIFEST.json");
    if (!manifest) throw new Error("缺少行情版本清单，无法确认账本数据是否最新");
  } else {
    const root = marketDataRoot() ?? path.join(process.cwd(), "data");
    if (existsSync(path.join(root, ".market-updating"))) throw new Error("行情正在同步，请稍后重算");
    const file = path.join(root, "MANIFEST.json");
    if (existsSync(file)) manifest = readFileSync(file, "utf8");
  }
  if (manifest) {
    const parsed = JSON.parse(manifest) as { generatedAt?: string; timeframes?: Record<string, { asOf?: string }> };
    if (!parsed.generatedAt || !Number.isFinite(Date.parse(parsed.generatedAt))) {
      throw new Error("行情版本清单无效");
    }
    for (const tf of ["4h", "2h"] as const) {
      const asOf = parsed.timeframes?.[tf]?.asOf;
      if (asOf != null && (typeof asOf !== "string" || !Number.isFinite(Date.parse(asOf)))) {
        throw new Error("行情版本清单的截至时间无效");
      }
    }
    return {
      marketRevision: createHash("sha256").update(manifest.trim()).digest("hex"),
      asOf: { "4h": parsed.timeframes?.["4h"]?.asOf, "2h": parsed.timeframes?.["2h"]?.asOf },
    };
  }
  const files = [rpsScaleFile()];
  for (const tf of ["1d", "4h", "2h"] as const) {
    const dir = csvDir(tf);
    if (existsSync(dir)) files.push(...readdirSync(dir).filter((f) => f.endsWith(".csv")).map((f) => path.join(dir, f)));
  }
  const stamps = files.sort().map((file) => {
    if (!existsSync(file)) return [file, null];
    const s = statSync(file);
    return [file, s.size, s.mtimeMs];
  });
  return { marketRevision: createHash("sha256").update(JSON.stringify(stamps)).digest("hex"), asOf: {} };
}
