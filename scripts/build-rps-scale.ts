import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { alphaScore } from "@/lib/backtest/engine";
import { getPreparedUniverse } from "@/lib/backtest/load";
import {
  quantileCuts,
  RPS_SCALE_PATH,
  SCALE_BUCKETS,
  type RpsScaleFile,
} from "@/lib/backtest/rpsScale";

/**
 * 生成标普 500 的 RPS 标尺：逐交易日取当日成分股的 alphaScore 分位切点。
 *
 * 只覆盖 `SCALE_FROM` 之后的日期——Small Fund 池最早回填到 2021-08，再往前的
 * 切点没人查，白占体积。要把窗口前移就改这个常量重跑。
 */

const SCALE_FROM = process.env.RPS_SCALE_FROM ?? "2021-01-01";

async function main() {
  const sp = await getPreparedUniverse("SP500", "1d");

  const dates: string[] = [];
  const cuts: number[][] = [];
  const counts: number[] = [];

  const cursor = new Int32Array(sp.symbols.length);
  const buf = new Float64Array(sp.symbols.length);

  for (let d = 0; d < sp.axis.length; d += 1) {
    let m = 0;
    for (let s = 0; s < sp.symbols.length; s += 1) {
      const sym = sp.symbols[s];
      const c = cursor[s];
      if (c >= sym.axisIndex.length || sym.axisIndex[c] !== d) continue;
      cursor[s] = c + 1;
      if (sym.isMember[c] === 0) continue;
      const score = alphaScore(sym.close, c);
      if (Number.isNaN(score)) continue;
      buf[m] = score;
      m += 1;
    }
    const date = sp.axis[d];
    if (date < SCALE_FROM || m === 0) continue;

    const sorted = Float64Array.from(buf.subarray(0, m)).sort();
    dates.push(date);
    // 分数量级在 100~1000，两位小数足够，省一半体积
    cuts.push(quantileCuts(sorted).map((v) => Math.round(v * 100) / 100));
    counts.push(m);
  }

  if (dates.length === 0) {
    throw new Error(`标尺为空：${SCALE_FROM} 之后没有可排名的交易日，检查标普面板缓存。`);
  }

  const file: RpsScaleFile = {
    generatedAt: new Date().toISOString(),
    index: "SP500",
    buckets: SCALE_BUCKETS,
    dates,
    cuts,
    counts,
  };

  mkdirSync(path.dirname(RPS_SCALE_PATH), { recursive: true });
  writeFileSync(RPS_SCALE_PATH, JSON.stringify(file));

  const median = [...counts].sort((a, b) => a - b)[counts.length >> 1];
  console.log(
    `[rps-scale] ${dates.length} 个交易日 ${dates[0]} → ${dates[dates.length - 1]}  ` +
      `每日样本中位 ${median} 只  ${SCALE_BUCKETS} 个切点  ` +
      `写入 ${RPS_SCALE_PATH}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
