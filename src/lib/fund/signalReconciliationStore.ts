import { createHash } from "node:crypto";
import { existsSync, opendirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { LiveBookCache } from "./liveBooksLogic";
import { champOf } from "./champs";
import { deskRemoteUrl, readDeskJson } from "./deskRemote";
import { buildSignalReconciliation, reconciliationTime, type SignalReconciliationReport, type TvJournalEvidence, type TvJournalReadResult } from "./signalReconciliation";

const MAX_RECORDS = 400;
// Keep in sync with the standalone desk HTTP projection. Budgets include old/out-of-window files.
const SCAN_LIMITS = { metadata: 2048, files: 512, bytes: 16 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, ms: 1000 };
const idPattern = /^[a-f0-9]{64}$/;
const finiteTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 8.64e15;
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Extract clocks only from full, uncompressed chart bars; never infer them from a fill. */
function barOpen(raw: Record<string, unknown>, close: number, compact: unknown): string | undefined {
  if (finiteTime(compact) && compact < close) return new Date(compact).toISOString();
  const chart = raw.chart as { version?: number; stride?: number; bars?: unknown[] } | undefined;
  if (chart?.version !== 1 || chart.stride !== 1 || !Array.isArray(chart.bars)) return;
  const row = chart.bars.find(r => Array.isArray(r) && r.length >= 6 && finiteTime(r[0]) && r[1] === close && r[0] < close);
  return Array.isArray(row) ? new Date(row[0]).toISOString() : undefined;
}

/** Validates the immutable journal identity and returns a strict field allowlist. */
export function tvJournalEvidenceOf(raw: unknown): TvJournalEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>, p = r.payload as Record<string, unknown> | undefined;
  if (r.version !== 1 || typeof r.id !== "string" || !idPattern.test(r.id) || !p || typeof p !== "object" ||
    (p.event !== "buy" && p.event !== "sell") || typeof p.symbol !== "string" || typeof p.tf !== "string" ||
    typeof p.strategyKey !== "string" || !p.strategyKey || p.strategyKey.length > 512 || !positive(p.price) ||
    !finiteTime(p.barTime) || !finiteTime(p.entrySignalTime) || p.barTime < p.entrySignalTime ||
    (p.kind !== undefined && p.kind !== 1 && p.kind !== 2) ||
    (p.event === "buy" && p.barTime !== p.entrySignalTime) || typeof r.capturedAt !== "string" || !reconciliationTime(r.capturedAt)) return null;
  const tf = p.tf === "240" || p.tf.toUpperCase() === "4H" ? "4h" : p.tf === "120" || p.tf.toUpperCase() === "2H" ? "2h" : null;
  const symbol = p.symbol.trim().toUpperCase().replace(/^.*:/, "");
  if (!tf || !/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol)) return null;
  const id = createHash("sha256").update(JSON.stringify([p.symbol.toUpperCase(), p.tf, p.strategyKey, p.entrySignalTime])).digest("hex");
  if (r.id !== id) return null;
  return { id, symbol, tf, event: p.event, strategyKey: p.strategyKey, price: p.price,
    ...(p.kind === 1 || p.kind === 2 ? { kind: p.kind } : {}),
    signalTime: new Date(p.barTime).toISOString(), entrySignalTime: new Date(p.entrySignalTime).toISOString(), capturedAt: reconciliationTime(r.capturedAt)!,
    ...(finiteTime(p.entryTime) ? { entryTime: new Date(p.entryTime).toISOString() } : {}),
    ...(positive(p.entry) ? { entryPrice: p.entry } : {}),
    signalBarOpenTime: barOpen(p, p.barTime, r.signalBarOpenTime),
    entrySignalBarOpenTime: barOpen(p, p.entrySignalTime, r.entrySignalBarOpenTime) };
}

/** Reads a bounded recent window plus symbols still held; it never mutates signal or account files. */
export async function readTvJournalEvidence(cache: LiveBookCache, now = new Date()): Promise<TvJournalReadResult> {
  const through = now.toISOString(), from = new Date(now.getTime() - 45 * 86_400_000).toISOString();
  const held = [...new Set(cache.books.flatMap(b => b.view.rows.map(r => r.symbol)))].filter(s => /^[A-Z][A-Z0-9.-]{0,15}$/.test(s));
  const result: TvJournalReadResult = { records: [], availability: "ok", from, through, truncated: false,
    parametersByTf: Object.fromEntries((["4h", "2h"] as const).map(tf => {
      const c = champOf(tf === "2h" ? "2h-broad" : "4h");
      return [tf, { stopMult: c.config.stopMult, trailMult: c.config.trailMult, takeProfitR: c.config.takeProfitR,
        useBuy1: c.config.useBuy1, useBuy2: c.config.useBuy2, requireRsi: c.config.requireRsi, minRsi: c.config.minRsi,
        requireVegas: c.config.requireVegas, entryAtDayCloseOnly: c.opts.entryWindow === "dayClose" }];
    })) };
  const localRoot = process.env.SIGNAL_JOURNAL_DIR || (process.env.LIVE_BOOKS_PATH ? path.dirname(process.env.LIVE_BOOKS_PATH) : undefined);
  let invalid = 0, sourcePartial = false;
  const collect = (value: unknown) => {
    const record = tvJournalEvidenceOf(value);
    if (!record) { invalid++; return; }
    if (record.signalTime > through || (record.signalTime < from && !held.includes(record.symbol))) return;
    const before = result.records.findIndex(r => r.signalTime < record.signalTime || (r.signalTime === record.signalTime && r.id > record.id));
    result.records.splice(before < 0 ? result.records.length : before, 0, record);
    if (result.records.length > MAX_RECORDS) { result.records.pop(); result.truncated = true; }
  };
  try {
    if (!localRoot && deskRemoteUrl("signal-reconciliation-evidence.json")) {
      const query = new URLSearchParams({ from, through, symbols: held.slice(0, 80).join(","), limit: String(MAX_RECORDS) });
      const data = await readDeskJson(`signal-reconciliation-evidence.json?${query}`, AbortSignal.timeout(8000)) as { records?: unknown[]; invalid?: number; missing?: number; truncated?: boolean };
      if (!data || !Array.isArray(data.records) || data.records.length > MAX_RECORDS || typeof data.truncated !== "boolean" || data.missing === 2) throw new Error("invalid archive");
      invalid = Number(data.invalid) || 0; sourcePartial = !!data.missing; result.truncated = data.truncated;
      for (const value of data.records) collect(value);
    } else {
      if (!localRoot && process.env.VERCEL) throw new Error("no persistent archive");
      const root = localRoot || path.join(process.cwd(), ".cache/signal-journal");
      let available = 0, inspected = 0, reads = 0, bytes = 0;
      const startedAt = Date.now();
      const candidates: { file: string; id: string; event: "buy" | "sell"; size: number; modified: number }[] = [];
      for (const [directory, event] of [["signal-entries", "buy"], ["signal-reviews", "sell"]] as const) {
        const dir = path.join(root, directory);
        if (!existsSync(dir)) { sourcePartial = true; continue; }
        available++;
        const handle = opendirSync(dir);
        try {
          for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
            if (++inspected > SCAN_LIMITS.metadata || Date.now() - startedAt >= SCAN_LIMITS.ms) { result.truncated = true; break; }
            if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
            try {
              const file = path.join(dir, entry.name), stat = statSync(file);
              candidates.push({ file, id: entry.name.slice(0, -5), event, size: stat.size, modified: stat.mtimeMs });
            } catch { invalid++; }
          }
        } finally { handle.closeSync(); }
      }
      if (!available) throw new Error("no archive directories");
      // Prefer recently archived evidence within the bounded metadata sample.
      candidates.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
      for (const candidate of candidates) {
        if (reads >= SCAN_LIMITS.files || Date.now() - startedAt >= SCAN_LIMITS.ms) { result.truncated = true; break; }
        if (candidate.size > SCAN_LIMITS.fileBytes || bytes + candidate.size > SCAN_LIMITS.bytes) { result.truncated = true; continue; }
        reads++; bytes += candidate.size;
        try {
          const record = JSON.parse(readFileSync(candidate.file, "utf8"));
          if (record?.id !== candidate.id || record?.payload?.event !== candidate.event) { invalid++; continue; }
          collect(record);
        } catch { invalid++; }
      }
    }
    if (invalid || sourcePartial || result.truncated) {
      result.availability = "partial";
      result.reason = `仅对比已读取的档案：${invalid ? `${invalid} 条无效或读取失败；` : ""}${sourcePartial ? "部分归档目录尚不可用；" : ""}${result.truncated ? "读取预算或记录数量达到本次上限；" : ""}未找到记录不等于漏推。`;
    }
  } catch {
    result.availability = "unavailable";
    result.reason = "TV 历史归档本次不可读取，未进行一致性判断；本地账户仍按原规则更新。";
    result.records = [];
  }
  return result;
}

export async function loadAndReconcileSignals(cache: LiveBookCache): Promise<SignalReconciliationReport> {
  const now = new Date();
  try { return buildSignalReconciliation(cache, await readTvJournalEvidence(cache, now), now); }
  catch { return buildSignalReconciliation(cache, { records: [], availability: "unavailable", reason: "本次对账未完成；不能使用旧报告判断当前账户。",
    from: new Date(now.getTime() - 45 * 86_400_000).toISOString(), through: now.toISOString(), truncated: false }, now); }
}
