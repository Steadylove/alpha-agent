import "./load-env";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { marketBaseUrl } from "@/lib/backtest/marketStore";
import { parseCatalystReport } from "@/lib/catalyst/normalize";
import type { CatalystReport, EventType } from "@/lib/catalyst/types";
import { readLiveBooks } from "@/lib/fund/liveBooksStore";
import type { LiveBookCache } from "@/lib/fund/liveBooksLogic";
import { readSignalPoolMembers, signalPoolPath } from "@/lib/fund/signalPool";
import { generateFundamentalAnalysis } from "@/lib/fundamental/analyst";
import { createFundamentalProvider } from "@/lib/fundamental/providers";
import { readFundamentalPeerDirectory } from "@/lib/fundamental/peerDirectory";
import { refreshFundamentalSymbol } from "@/lib/fundamental/service";
import { readFundamentalState } from "@/lib/fundamental/store";
import { symbolSchema, type FundamentalState } from "@/lib/fundamental/types";
import { snapshotDir, snapshotFile } from "@/lib/vps/snapshot";

export { readFundamentalPeerDirectory } from "@/lib/fundamental/peerDirectory";

const DAY = 86400000;
// Earnings are handled by financial-statement/consensus changes; only unmodelled company events require review.
const MATERIAL_TYPES = new Set<EventType>(["Guidance", "Corporate", "M&A", "Regulatory", "Capital / Financing", "Legal", "FDA / Clinical"]);
class CliError extends Error {}
export type FundamentalJobOptions = { symbol?: string; limit: number; dryRun: boolean; force: boolean; noAi: boolean; reviewedEventIds: string[] };
type Candidate = { symbol: string; state: FundamentalState | null; eventIds: string[] };

export function parseFundamentalArgs(args: string[]): FundamentalJobOptions {
  const result: FundamentalJobOptions = { limit: 12, dryRun: false, force: false, noAi: false, reviewedEventIds: [] };
  for (const arg of args) {
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--force") result.force = true;
    else if (arg === "--no-ai") result.noAi = true;
    else if (arg.startsWith("--symbol=")) {
      const symbol = symbolSchema.safeParse(arg.slice(9).toUpperCase());
      if (!symbol.success || result.symbol) throw new CliError("invalid-symbol");
      result.symbol = symbol.data;
    } else if (/^--limit=\d+$/.test(arg)) {
      result.limit = Number(arg.slice(8));
      if (!Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 100) throw new CliError("invalid-limit");
    } else if (/^--review-event=[a-f0-9]{24}$/.test(arg)) result.reviewedEventIds.push(arg.slice(15));
    else throw new CliError("invalid-arguments");
  }
  result.reviewedEventIds = [...new Set(result.reviewedEventIds)];
  if (result.reviewedEventIds.length && !result.symbol) throw new CliError("event-review-requires-symbol");
  return result;
}

/** Saved universe only: opportunity/sector/market membership never expands valuation coverage. */
export function fundamentalUniverse(pool: string[], books: LiveBookCache | null, report: CatalystReport | null, now: Date): string[] {
  const symbols = [...pool];
  if (books && Date.parse(books.computedAt) <= now.getTime())
    for (const book of books.books) for (const row of book.view.rows) symbols.push(row.symbol);
  if (report && Date.parse(report.universe.observedAt) <= now.getTime())
    for (const row of report.universe.symbols) if (row.relations.some(relation =>
      ["portfolio", "signal"].includes(relation.kind) && Date.parse(relation.observedAt) <= now.getTime())) symbols.push(row.symbol);
  return [...new Set(symbols.filter(symbol => symbolSchema.safeParse(symbol).success))].sort();
}

/** Only actual publication/amendment time can make an event newer than valuation evidence. */
export function fundamentalEventIds(symbol: string, state: FundamentalState | null, report: CatalystReport | null, now: Date): string[] {
  const since = state?.current ? Date.parse(state.current.input.observedAt) : now.getTime() - 30 * DAY;
  return (report?.events ?? []).filter(event => {
    if (event.status !== "published" || event.importance !== "high" || event.scope !== "stock" ||
      !event.symbols.includes(symbol) || !MATERIAL_TYPES.has(event.type) || !event.publishedAt) return false;
    const published = Date.parse(event.publishedAt);
    if (!Number.isFinite(published) || published > now.getTime()) return false;
    const changed = event.sourceUpdatedAt ? Date.parse(event.sourceUpdatedAt) : published;
    if (!Number.isFinite(changed) || changed > now.getTime() || changed < published) return false;
    return changed > since;
  }).map(event => event.id);
}

export function selectFundamentalCandidates(candidates: Candidate[], options: FundamentalJobOptions, now: Date): Candidate[] {
  return candidates.filter(candidate => options.force || options.reviewedEventIds.length || !candidate.state ||
    Date.parse(candidate.state.nextCheckAt) <= now.getTime() || candidate.eventIds.some(id => !candidate.state!.eventIds.includes(id)))
    .sort((a, b) => Number(Boolean(a.state)) - Number(Boolean(b.state)) ||
      Date.parse(a.state?.nextCheckAt ?? "1970-01-01") - Date.parse(b.state?.nextCheckAt ?? "1970-01-01") || a.symbol.localeCompare(b.symbol))
    .slice(0, options.limit);
}

function readLocalCatalyst(now: Date): { report: CatalystReport | null; warnings: string[] } {
  try {
    const file = snapshotFile("catalyst/latest");
    if (!existsSync(file)) return { report: null, warnings: ["事件归档尚不可用，重大事件覆盖不完整"] };
    const report = parseCatalystReport(JSON.parse(readFileSync(file, "utf8")));
    if (Date.parse(report.generatedAt) > now.getTime()) throw new Error("future report");
    const warnings: string[] = [];
    if (now.getTime() - Date.parse(report.generatedAt) > 48 * 3600000) warnings.push("事件归档超过 48 小时未更新，重大事件覆盖可能不足");
    if (!report.sources.length || report.sources.some(source => source.state !== "ok") || report.warnings.length)
      warnings.push("事件来源存在缺项；未收录不能视为不存在重大事件");
    return { report, warnings };
  } catch { return { report: null, warnings: ["事件归档读取或校验失败，重大事件覆盖不完整"] }; }
}

/** Shared by direct CLI/manual and timer jobs. PID probing only recovers demonstrably dead owners. */
export async function withFundamentalLock<T>(run: () => Promise<T>, lockFile = path.join(path.dirname(snapshotDir()), ".fundamental-target.lock")): Promise<T> {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  let fd: number;
  try { fd = openSync(lockFile, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(readFileSync(lockFile, "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new CliError("invalid-lock");
    try { process.kill(pid, 0); throw new CliError("lock-busy"); }
    catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
    unlinkSync(lockFile);
    fd = openSync(lockFile, "wx", 0o600);
  }
  try { writeFileSync(fd, String(process.pid)); return await run(); }
  finally {
    closeSync(fd);
    if (existsSync(lockFile) && readFileSync(lockFile, "utf8") === String(process.pid)) unlinkSync(lockFile);
  }
}

export async function runFundamentalJob(options: FundamentalJobOptions): Promise<void> {
  if (marketBaseUrl()) throw new CliError("remote-writer-disabled");
  const execute = async () => {
    const now = new Date(), { report, warnings } = readLocalCatalyst(now);
    const [poolResult, booksResult] = await Promise.allSettled([
      existsSync(signalPoolPath()) ? readSignalPoolMembers() : Promise.resolve(null), readLiveBooks(),
    ]);
    const pool = poolResult.status === "fulfilled" ? poolResult.value : null;
    const books = booksResult.status === "fulfilled" ? booksResult.value : null;
    if (!pool) warnings.push("信号池不可读取，本轮覆盖可能不完整");
    if (!books) warnings.push("账本不可读取，本轮持仓覆盖可能不完整");
    const symbols = options.symbol ? [options.symbol] : fundamentalUniverse(pool ?? [], books, report, now);
    const candidates: Candidate[] = [];
    let failed = false;
    for (const symbol of symbols) {
      try {
        const state = readFundamentalState(symbol);
        candidates.push({ symbol, state, eventIds: fundamentalEventIds(symbol, state, report, now) });
      } catch {
        // One damaged ticker must not block independent symbols or overwrite its previous state.
        failed = true;
        console.log(JSON.stringify({ symbol, status: "invalid-saved-state", reasonsCount: 1 }));
      }
    }
    if (options.reviewedEventIds.some(id => !candidates.some(candidate => candidate.state?.eventIds.includes(id) || candidate.eventIds.includes(id))))
      throw new CliError("unknown-review-event");
    const selected = selectFundamentalCandidates(candidates, options, now);
    if (options.dryRun) {
      for (const candidate of selected) console.log(JSON.stringify({ symbol: candidate.symbol, status: "dry-run", reasonsCount: warnings.length + candidate.eventIds.length }));
      if (failed) throw new CliError("partial-failure");
      return;
    }
    if (!selected.length) { if (failed) throw new CliError("partial-failure"); return; }
    if (!process.env.FMP_API_KEY?.trim()) throw new CliError("missing-fmp-key");
    const collect = createFundamentalProvider({ peerDirectory: readFundamentalPeerDirectory(now) });
    const apiKey = process.env.DEEPSEEK_FUNDAMENTAL_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_REVIEW_API_KEY;
    const analyze = !options.noAi && apiKey ? (valuation: Parameters<typeof generateFundamentalAnalysis>[0]) =>
      generateFundamentalAnalysis(valuation, { apiKey, model: process.env.DEEPSEEK_FUNDAMENTAL_MODEL || process.env.DEEPSEEK_REVIEW_MODEL }) : undefined;
    for (const candidate of selected) {
      try {
        const result = await refreshFundamentalSymbol(candidate.symbol, { force: options.force, eventIds: candidate.eventIds,
          reviewedEventIds: options.reviewedEventIds, coverageWarnings: warnings }, { collect, analyze });
        console.log(JSON.stringify({ symbol: candidate.symbol, status: result.status === "cached" ? "cached" : result.state.status, reasonsCount: result.state.reasons.length }));
      } catch {
        failed = true;
        console.log(JSON.stringify({ symbol: candidate.symbol, status: "failed", reasonsCount: 1 }));
      }
    }
    if (failed) throw new CliError("partial-failure");
  };
  // Dry runs are entirely read-only, including no lock file or directory creation.
  if (options.dryRun) await execute();
  else await withFundamentalLock(execute);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve().then(() => runFundamentalJob(parseFundamentalArgs(process.argv.slice(2)))).catch((error: unknown) => {
    console.error(JSON.stringify({ symbol: null, status: error instanceof CliError ? error.message : "job-failed", reasonsCount: 1 }));
    process.exitCode = 1;
  });
}
