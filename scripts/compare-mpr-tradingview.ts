import "dotenv/config";

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

import { getPrisma } from "@/lib/db/prisma";
import {
  MPR_SYMBOLS,
  alignMprInputs,
  computeMprSeries,
  type AlignBar,
  type MprDay,
  type MprSymbol,
} from "@/lib/scoring/mpr";

/**
 * 把本地 MPR 输出与 TradingView 导出的 CSV 逐日对拍。
 *
 * TradingView 只在此处充当真值来源，用于确认 Pine -> TypeScript 的移植是否忠实；
 * 生产链路不依赖它。导出方法见 docs/plans/tradingview-export-patch.pine。
 *
 *   npm run compare:mpr             对拍并打印差异报告
 *   npm run compare:mpr -- --freeze 额外冻结抽样到 tests/fixtures/mpr-golden.json
 */

const CSV_PATH = "tmp/mpr-tradingview.csv";
const GOLDEN_PATH = "tests/fixtures/mpr-golden.json";
const WARMUP_BARS = 252;
/** 冻结进回归夹具的样本条数。 */
const GOLDEN_SAMPLES = 40;

/** CSV 列名 -> MprDay 字段，以及该字段允许的绝对误差。 */
const FIELD_MAP: Array<{ csv: string; key: keyof MprDay; tolerance: number }> = [
  { csv: "exp_f1", key: "f1", tolerance: 0.01 },
  { csv: "exp_f2", key: "f2", tolerance: 0.01 },
  { csv: "exp_f3", key: "f3", tolerance: 0.01 },
  { csv: "exp_f4", key: "f4", tolerance: 0.01 },
  { csv: "exp_f5", key: "f5", tolerance: 0.01 },
  { csv: "exp_raw_term", key: "rawTerm", tolerance: 1e-6 },
  { csv: "exp_raw_cred", key: "rawCred", tolerance: 1e-6 },
  { csv: "exp_spy_damage", key: "spyDamage", tolerance: 0 },
  { csv: "exp_lead_gap", key: "leadGap", tolerance: 0.01 },
  { csv: "exp_lead_persist", key: "leadPersist", tolerance: 0 },
  { csv: "exp_lead_quality", key: "leadQuality", tolerance: 0.01 },
  { csv: "exp_path_id", key: "pathId", tolerance: 0 },
  { csv: "exp_fsm_state", key: "fsmState", tolerance: 0 },
  { csv: "exp_prob_5d_down", key: "prob5dDown", tolerance: 0.05 },
  { csv: "exp_risk_score", key: "marketRiskScore", tolerance: 0.05 },
  { csv: "exp_trans_vel", key: "transVel", tolerance: 0.001 },
];

function parseCsv(text: string): Map<string, Record<string, number>> {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
  const timeIdx = header.findIndex((c) => /^(time|date)$/i.test(c));
  if (timeIdx < 0) throw new Error(`CSV 缺少 time/date 列，实际表头: ${header.join(", ")}`);

  const missing = FIELD_MAP.filter((f) => !header.includes(f.csv)).map((f) => f.csv);
  if (missing.length > 0) {
    throw new Error(
      `CSV 缺少导出列: ${missing.join(", ")}\n` +
        `请确认已粘贴 docs/plans/tradingview-export-patch.pine，且按其中「如果导出的 CSV 里没有 exp_* 列」一节处理。`,
    );
  }

  const rows = new Map<string, Record<string, number>>();
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const raw = cells[timeIdx];
    // TradingView 导出可能是 ISO 时间戳，也可能是 Unix 秒
    const date = /^\d+$/.test(raw)
      ? new Date(Number(raw) * 1000).toISOString().slice(0, 10)
      : raw.slice(0, 10);

    const record: Record<string, number> = {};
    for (const field of FIELD_MAP) {
      const value = Number(cells[header.indexOf(field.csv)]);
      if (Number.isFinite(value)) record[field.csv] = value;
    }
    if (Object.keys(record).length > 0) rows.set(date, record);
  }
  return rows;
}

async function loadLocalSeries(): Promise<MprDay[]> {
  const prisma = getPrisma();
  const bySymbol = {} as Record<MprSymbol, AlignBar[]>;
  for (const symbol of MPR_SYMBOLS) {
    const instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) throw new Error(`Instrument ${symbol} not found. Run: npm run backfill:macro`);
    const bars = await prisma.dailyBar.findMany({
      where: { instrumentId: instrument.id },
      orderBy: { date: "asc" },
      select: { date: true, close: true, volume: true },
    });
    bySymbol[symbol] = bars.map((bar) => ({
      date: bar.date.toISOString().slice(0, 10),
      close: bar.close,
      volume: Number(bar.volume),
    }));
  }
  return computeMprSeries(alignMprInputs(bySymbol));
}

async function main() {
  let csvText: string;
  try {
    csvText = readFileSync(CSV_PATH, "utf8");
  } catch {
    console.error(`未找到 ${CSV_PATH}`);
    console.error("请先按 docs/plans/tradingview-export-patch.pine 从 TradingView 导出 CSV。");
    process.exit(1);
    return;
  }

  const expected = parseCsv(csvText);
  const local = (await loadLocalSeries()).slice(WARMUP_BARS);
  const overlap = local.filter((day) => expected.has(day.date));

  console.log(`本地序列 ${local.length} 天，CSV ${expected.size} 天，重叠 ${overlap.length} 天`);
  if (overlap.length === 0) {
    throw new Error("无重叠交易日。检查图表标的是否为 SPY、周期是否为 1D。");
  }

  type Stat = { checked: number; mismatched: number; maxDiff: number; worstDate: string };
  const stats = new Map<string, Stat>();
  const sampleMismatches: string[] = [];

  for (const day of overlap) {
    const row = expected.get(day.date)!;
    for (const field of FIELD_MAP) {
      const want = row[field.csv];
      if (want === undefined) continue;
      const got = day[field.key] as number;
      const diff = Math.abs(got - want);

      const stat = stats.get(field.csv) ?? {
        checked: 0,
        mismatched: 0,
        maxDiff: 0,
        worstDate: "",
      };
      stat.checked += 1;
      if (diff > field.tolerance) {
        stat.mismatched += 1;
        if (sampleMismatches.length < 15) {
          sampleMismatches.push(
            `  ${day.date} ${field.csv.padEnd(18)} TV=${want.toFixed(4).padStart(10)} 本地=${got.toFixed(4).padStart(10)} Δ=${diff.toFixed(4)}`,
          );
        }
      }
      if (diff > stat.maxDiff) {
        stat.maxDiff = diff;
        stat.worstDate = day.date;
      }
      stats.set(field.csv, stat);
    }
  }

  console.log("");
  console.log("字段              比对数   不符   不符率    最大偏差   最差日期");
  console.log("─".repeat(74));
  let totalMismatched = 0;
  for (const field of FIELD_MAP) {
    const stat = stats.get(field.csv);
    if (!stat) {
      console.log(`${field.csv.padEnd(18)} (CSV 中无有效值)`);
      continue;
    }
    totalMismatched += stat.mismatched;
    const rate = (stat.mismatched / stat.checked) * 100;
    console.log(
      `${field.csv.padEnd(18)} ${String(stat.checked).padStart(6)} ${String(stat.mismatched).padStart(6)} ` +
        `${rate.toFixed(2).padStart(7)}% ${stat.maxDiff.toExponential(2).padStart(11)}   ${stat.worstDate}`,
    );
  }

  if (sampleMismatches.length > 0) {
    console.log("");
    console.log("差异样本（最多 15 条）:");
    console.log(sampleMismatches.join("\n"));
  }

  console.log("");
  if (totalMismatched === 0) {
    console.log("✓ 全字段逐日一致，移植忠实。");
  } else {
    console.log(`✗ 共 ${totalMismatched} 处超出容差。移植存在偏差，先修实现再重跑校准。`);
  }

  if (process.argv.includes("--freeze")) {
    if (totalMismatched > 0) {
      console.log("");
      console.log("对拍未通过，拒绝冻结夹具。");
      await getPrisma().$disconnect();
      process.exit(1);
    }
    // 均匀抽样，覆盖不同市场状态而非只取一段
    const step = Math.max(1, Math.floor(overlap.length / GOLDEN_SAMPLES));
    const samples = overlap
      .filter((_, i) => i % step === 0)
      .slice(0, GOLDEN_SAMPLES)
      .map((day) => {
        const row = expected.get(day.date)!;
        const entry: Record<string, number | string> = { date: day.date };
        for (const field of FIELD_MAP) {
          if (row[field.csv] !== undefined) entry[field.csv] = row[field.csv];
        }
        return entry;
      });

    mkdirSync("tests/fixtures", { recursive: true });
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(samples, null, 2)}\n`);
    console.log("");
    console.log(`已冻结 ${samples.length} 条真值样本到 ${GOLDEN_PATH}`);
  }

  await getPrisma().$disconnect();
  if (totalMismatched > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await getPrisma().$disconnect();
  process.exit(1);
});
