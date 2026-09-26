import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readLiveBooks } from "@/lib/fund/liveBooksStore";
import type { LiveBookCache } from "@/lib/fund/liveBooksLogic";
import { getOpportunityData } from "@/lib/dashboard/opportunity";
import type { OpportunityData, OpportunityStock } from "@/lib/opportunity/types";
import { EXTRA_SECTORS } from "@/lib/opportunity/extraSectors";
import { formatIndustryLabel } from "@/lib/i18n/gicsZh";
import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";
import { strictSectorId } from "@/lib/signals/sectorFactor";
import { tradeIdOf } from "@/lib/signals/journal";
import type { AlertPayload } from "@/lib/discord/tvAlertCopy";
import { reviewTf } from "@/lib/review/journal";
import type { JournalArchive } from "@/lib/review/types";
import { readSnapshot } from "@/lib/vps/snapshot";
import type { CatalystUniverse, EventInput, Relation, SourceHealth, UniverseSignal, UniverseSymbol } from "./types";

const DAY = 86_400_000;
const MAX_OPPORTUNITIES = 250;
const MAX_SYMBOLS = 250;
const sectorIds = new Set<string>(SECTOR_UNIVERSE.map((sector) => sector.id));
const tickerOf = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const value = raw.slice(raw.lastIndexOf(":") + 1).trim().toUpperCase().replace(/\./g, "-");
  return /^[A-Z0-9^][A-Z0-9^-]{0,15}$/.test(value) ? value : null;
};
const knownTime = (value: unknown, now: Date): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now.getTime();

export type LocalSignalRecords = { records: unknown[]; available: boolean; partial: boolean; detail: string };
export type CatalystUniverseLoaders = {
  books: () => Promise<LiveBookCache | null>;
  opportunity: () => Promise<OpportunityData>;
  journal: () => Promise<JournalArchive | null>;
  localSignals: () => Promise<LocalSignalRecords>;
};

/** Only the real signal archive is read. A missing directory is not an empty signal history. */
async function localSignals(): Promise<LocalSignalRecords> {
  const root = process.env.SIGNAL_JOURNAL_DIR || path.join(process.cwd(), ".cache/signal-journal");
  const directories = ["signal-entries", "signal-reviews"].map((name) => path.join(root, name));
  const existing = directories.filter((dir) => existsSync(dir));
  if (!existing.length) return { records: [], available: false, partial: false, detail: "本地真实信号目录不可用；不能据此认定没有买卖信号。" };
  const files = existing.flatMap((dir) => readdirSync(dir).filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).map((file) => path.join(dir, file)))
    .map((file) => ({ file, modified: statSync(file).mtimeMs })).sort((a, b) => b.modified - a.modified);
  const records: unknown[] = [];
  let errors = 0;
  for (const { file } of files.slice(0, 5000)) {
    try { records.push(JSON.parse(readFileSync(file, "utf8"))); } catch { errors++; }
  }
  const partial = existing.length !== directories.length || errors > 0 || files.length > 5000;
  return { records, available: true, partial, detail: `真实买点/卖点归档；${errors} 个文件读取失败${files.length > 5000 ? "；仅读取最近修改的 5000 个文件" : ""}${existing.length < 2 ? "；其中一个归档目录缺失" : ""}。` };
}

const defaultLoaders: CatalystUniverseLoaders = {
  books: readLiveBooks,
  opportunity: getOpportunityData,
  journal: () => readSnapshot<JournalArchive>("daily-review/journal", AbortSignal.timeout(8000)),
  localSignals,
};

function realSignal(raw: { id?: unknown; symbol?: unknown; tf?: unknown; event?: unknown; signalTime?: unknown; capturedAt?: unknown }, now: Date): UniverseSignal | null {
  const symbol = tickerOf(raw.symbol);
  const tf = typeof raw.tf === "string" ? reviewTf(raw.tf) : null;
  const signalTime = typeof raw.signalTime === "number" ? raw.signalTime : NaN;
  if (!symbol || !tf || typeof raw.id !== "string" || !/^[a-f0-9]{64}$/.test(raw.id) ||
      (raw.event !== "buy" && raw.event !== "sell") || !Number.isFinite(signalTime) ||
      signalTime < now.getTime() - 10 * DAY || signalTime > now.getTime() || !knownTime(raw.capturedAt, now)) return null;
  const lag = Date.parse(raw.capturedAt) - signalTime;
  if (lag < -60_000 || lag > 15 * 60_000) return null;
  return { id: `${raw.id}:${raw.event}`, symbol, tf, event: raw.event, signalTime: new Date(signalTime).toISOString(), capturedAt: raw.capturedAt };
}

/** Read-only source joins. Relations describe this observation, never historical event-time holdings. */
export async function loadCatalystUniverse(now: Date, loaders: CatalystUniverseLoaders = defaultLoaders): Promise<CatalystUniverse> {
  if (!Number.isFinite(now.getTime())) throw new Error("Catalyst observation time is invalid");
  const observedAt = now.toISOString();
  const health: SourceHealth[] = [];
  const sources = await Promise.allSettled([
    Promise.resolve().then(loaders.books), Promise.resolve().then(loaders.opportunity),
    Promise.resolve().then(loaders.journal), Promise.resolve().then(loaders.localSignals),
  ]);
  const books = sources[0].status === "fulfilled" ? sources[0].value : null;
  const opportunity = sources[1].status === "fulfilled" ? sources[1].value : null;
  const journal = sources[2].status === "fulfilled" ? sources[2].value : null;
  const local = sources[3].status === "fulfilled" ? sources[3].value : null;
  const opportunityReady = opportunity != null && knownTime(opportunity.asOf, now) && Array.isArray(opportunity.universe) && Array.isArray(opportunity.pool) && Array.isArray(opportunity.candidates);
  const metadata = new Map<string, OpportunityStock>();
  if (opportunityReady) for (const stock of [...opportunity.universe, ...opportunity.pool, ...opportunity.candidates]) {
    const symbol = tickerOf(stock?.symbol);
    if (symbol) metadata.set(symbol, stock);
  }
  const universe = new Map<string, UniverseSymbol>();
  const dates: string[] = [];
  const add = (symbol: string, relation: Relation) => {
    let row = universe.get(symbol);
    if (!row) {
      const stock = metadata.get(symbol), extra = EXTRA_SECTORS[symbol];
      row = { symbol, name: stock?.name || symbol,
        sectorId: stock?.sectorId && sectorIds.has(stock.sectorId) ? stock.sectorId : strictSectorId(extra?.sector) ?? null,
        industry: stock?.industryLabel && stock.industryLabel !== "未分类" ? stock.industryLabel : extra ? formatIndustryLabel(extra.sector, extra.industry) : null,
        relations: [] };
      universe.set(symbol, row);
    }
    if (!row.relations.some((existing) => existing.kind === relation.kind && existing.key === relation.key)) row.relations.push(relation);
    dates.push(relation.asOf.slice(0, 10));
  };
  for (const tf of ["2h", "4h"] as const) {
    const book = books?.books?.find((item) => item.tf === tf);
    if (!books || !knownTime(books.computedAt, now) || !book || !knownTime(book.view?.asOf, now) || !Array.isArray(book.view.rows)) {
      health.push({ id: `portfolio-${tf}`, label: `${tf.toUpperCase()} 模型持仓`, state: "unavailable", checkedAt: observedAt, count: 0, detail: "模型账本缺失、读取失败或时间无效；不代表空仓。" });
      continue;
    }
    let invalid = 0;
    for (const row of book.view.rows) {
      const symbol = tickerOf(row?.symbol);
      if (!symbol) { invalid++; continue; }
      add(symbol, { kind: "portfolio", key: `portfolio:${tf}:${symbol}`, label: `${tf.toUpperCase()} 模型持仓 · ${symbol}`, tf, asOf: book.view.asOf, observedAt });
    }
    dates.push(book.view.asOf.slice(0, 10));
    health.push({ id: `portfolio-${tf}`, label: `${tf.toUpperCase()} 模型持仓`, state: invalid ? "partial" : "ok", checkedAt: observedAt, count: book.view.rows.length - invalid,
      detail: `账本截至 ${book.view.asOf}，生成于 ${books.computedAt}${invalid ? `；${invalid} 条持仓无效` : ""}。` });
  }
  const signals = new Map<string, UniverseSignal>();
  if (journal?.version === 1 && knownTime(journal.builtAt, now) && knownTime(journal.asOf, now) && Array.isArray(journal.signals)) {
    let invalid = 0;
    for (const row of journal.signals) {
      if (!row || !/^[a-f0-9]{64}$/.test(row.id) || !tickerOf(row.symbol) || !reviewTf(row.tf) ||
          !Number.isFinite(row.signalTime) || !Number.isFinite(Date.parse(row.capturedAt)) ||
          (row.source !== "live" && row.source !== "replay")) { invalid++; continue; }
      if (row?.source !== "live") continue;
      const signal = realSignal({ ...row, event: "buy" }, now);
      if (signal) signals.set(signal.id, signal);
    }
    health.push({ id: "signal-journal", label: "真实买点复盘归档", state: invalid ? "partial" : "ok", checkedAt: observedAt, count: signals.size, detail: `截至 ${journal.asOf}，生成于 ${journal.builtAt}；仅采用近 10 天真实买点，不含回放${invalid ? `；${invalid} 条损坏记录已排除` : ""}。` });
  } else health.push({ id: "signal-journal", label: "真实买点复盘归档", state: "unavailable", checkedAt: observedAt, count: 0, detail: "真实买点复盘归档不可用；不能据此认定没有信号。" });
  let localCount = 0, invalidRecords = 0;
  if (local?.available) for (const raw of local.records) {
    const row = raw as { version?: number; id?: string; payload?: AlertPayload; capturedAt?: string; candidate?: { replay?: boolean }; source?: string } | null;
    if (!row?.payload || row.version !== 1 || tradeIdOf(row.payload) !== row.id) { invalidRecords++; continue; }
    if (row.candidate?.replay || row.source === "replay") continue;
    const signal = realSignal({ id: row.id, symbol: row.payload.symbol, tf: row.payload.tf, event: row.payload.event, signalTime: row.payload.barTime, capturedAt: row.capturedAt }, now);
    if (signal) { signals.set(signal.id, signal); localCount++; }
  }
  health.push({ id: "signal-live-archive", label: "真实买卖点捕获归档", state: !local?.available ? "unavailable" : local.partial || invalidRecords > 0 ? "partial" : "ok", checkedAt: observedAt, count: localCount,
    detail: local?.detail ? `${local.detail}${invalidRecords ? ` ${invalidRecords} 条无效记录已排除。` : ""}` : "本地真实买卖点目录不可用；不能据此认定没有卖点。" });
  const recentSignals = [...signals.values()].sort((a, b) => b.signalTime.localeCompare(a.signalTime) || a.id.localeCompare(b.id));
  for (const signal of recentSignals) add(signal.symbol, { kind: "signal", key: `signal:${signal.id}`, label: `${signal.tf.toUpperCase()} ${signal.event === "buy" ? "买点" : "卖点"} · ${signal.symbol}`, tf: signal.tf, asOf: signal.signalTime, observedAt });
  if (opportunityReady) {
    const candidates = new Set(opportunity.candidates.map((stock) => tickerOf(stock?.symbol)).filter(Boolean));
    const selected = [...metadata.values()].filter((stock) => stock.elite || candidates.has(tickerOf(stock.symbol)) || (Number.isFinite(stock.rps50) && stock.rps50! >= 80))
      .sort((a, b) => Number(b.elite) - Number(a.elite) || (b.rps50 ?? -1) - (a.rps50 ?? -1) || a.symbol.localeCompare(b.symbol));
    for (const stock of selected.slice(0, MAX_OPPORTUNITIES)) {
      const symbol = tickerOf(stock.symbol)!;
      add(symbol, { kind: "opportunity", key: `opportunity:${symbol}`, label: `Opportunity · ${symbol}`, asOf: opportunity.asOf!, observedAt });
    }
    dates.push(opportunity.asOf!.slice(0, 10));
    health.push({ id: "opportunity", label: "Opportunity 机会观察池", state: opportunity.missingSymbols?.length || selected.length > MAX_OPPORTUNITIES ? "partial" : "ok", checkedAt: observedAt, count: Math.min(selected.length, MAX_OPPORTUNITIES),
      detail: `截至 ${opportunity.asOf}；采用候选、elite 或 RPS50 ≥ 80 的标的${selected.length > MAX_OPPORTUNITIES ? `；${selected.length} 只中保留优先级最高的 ${MAX_OPPORTUNITIES} 只` : ""}${opportunity.missingSymbols?.length ? `；${opportunity.missingSymbols.length} 个源标的缺失` : ""}。` });
  } else health.push({ id: "opportunity", label: "Opportunity 机会观察池", state: "unavailable", checkedAt: observedAt, count: 0, detail: "机会快照缺失、读取失败或时间无效；不代表没有候选机会。" });
  const symbols = [...universe.values()].slice(0, MAX_SYMBOLS);
  if (universe.size > MAX_SYMBOLS) health.push({ id: "universe-limit", label: "关联对象覆盖", state: "partial", checkedAt: observedAt, count: symbols.length, detail: `${universe.size} 只关联标的中保留 ${MAX_SYMBOLS} 只；优先级为模型持仓、近期真实信号、机会池。` });
  const included = new Set(symbols.map((row) => row.symbol));
  return { asOf: dates.sort().at(-1) ?? observedAt.slice(0, 10), observedAt, symbols,
    sectors: SECTOR_UNIVERSE.map((sector) => ({ id: sector.id, name: sector.name, etf: sector.symbol, leader: Boolean(opportunityReady && opportunity.leaders?.includes(sector.id)), ...(opportunityReady ? { asOf: opportunity.asOf!.slice(0, 10) } : {}) })),
    signals: recentSignals.filter((signal) => included.has(signal.symbol)), health };
}

/** Sector IDs are explicit provider metadata; TECH is never inferred to mean semiconductors. */
export function associateEvent(event: EventInput, universe: CatalystUniverse): Relation[] {
  const relations = new Map<string, Relation>();
  const add = (relation: Relation) => relations.set(`${relation.kind}:${relation.key}`, { ...relation });
  if (event.scope === "market") add({ kind: "market", key: "market:US", label: "美国市场", asOf: universe.asOf, observedAt: universe.observedAt });
  const symbols = new Set(event.symbols.map(tickerOf).filter(Boolean));
  for (const row of universe.symbols) if (symbols.has(row.symbol)) row.relations.forEach(add);
  if (event.scope !== "market") for (const sector of universe.sectors.filter((row) => event.sectorIds.includes(row.id))) {
    const related = universe.symbols.filter((row) => row.sectorId === sector.id);
    if (!sector.leader && (event.scope !== "sector" || !related.length)) continue;
    add({ kind: "sector", key: `sector:${sector.id}`, label: `${sector.name} · ${sector.etf}`, asOf: sector.asOf ?? universe.asOf, observedAt: universe.observedAt });
    // A company's industry tag does not make every peer's portfolio relation relevant.
    if (event.scope === "sector") related.forEach((row) => row.relations.forEach(add));
  }
  return [...relations.values()];
}
