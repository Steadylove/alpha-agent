import type { LiveBookCache, LiveBookOk } from "./liveBooksLogic";
import type { LookbackTf } from "./lookbackLogic";
import type { SignalExecutionEvent, SignalTracking } from "./signalTracking";

export type SignalComparableParameters = {
  stopMult: number; trailMult: number; takeProfitR: number | null;
  useBuy1: boolean; useBuy2: boolean; requireRsi: boolean; minRsi: number;
  requireVegas: boolean; entryAtDayCloseOnly: boolean;
};
export type TvJournalEvidence = {
  id: string; symbol: string; tf: LookbackTf; event: "buy" | "sell";
  signalTime: string; entrySignalTime: string; capturedAt: string; strategyKey: string;
  price: number; kind?: 1 | 2; entryPrice?: number; entryTime?: string;
  /** Only populated from a stride=1 chart row with the exact recorded close. */
  signalBarOpenTime?: string; entrySignalBarOpenTime?: string;
};
export type TvJournalReadResult = {
  records: TvJournalEvidence[]; availability: "ok" | "partial" | "unavailable";
  reason?: string; from: string; through: string; truncated: boolean;
  parametersByTf?: Partial<Record<LookbackTf, SignalComparableParameters>>;
};
export type SignalParameterDifference = {
  field: string; label: string; local: number | boolean | null | string; tv: number | boolean | null | string;
};
export type SignalReconciliationRow = {
  id: string; tf: LookbackTf; symbol: string; event: "buy" | "sell";
  status: "matched" | "different" | "local_record_not_found" | "tv_record_not_found" | "unverifiable";
  summary: string; evidence: "signal" | "account_fill";
  localSignalTime?: string; tvSignalTime?: string; localPrice?: number; tvPrice?: number;
  localFillTime?: string; tvEntryTime?: string;
  parameterDifferences: SignalParameterDifference[]; differences: string[];
};
export type SignalReconciliationReport = {
  version: 1; generatedAt: string; asOf: string;
  availability: "ok" | "partial" | "unavailable"; note: string;
  coverage: { from: string; through: string; tvRecords: number; localEvents: number; legacyTimeframes: LookbackTf[]; truncated: boolean };
  rows: SignalReconciliationRow[];
};

const fields: { field: keyof SignalComparableParameters; label: string }[] = [
  { field: "stopMult", label: "初始止损 ATR 倍数" }, { field: "trailMult", label: "吊灯 ATR 倍数" },
  { field: "takeProfitR", label: "固定止盈 R 倍数" }, { field: "useBuy1", label: "一买" },
  { field: "useBuy2", label: "二买" }, { field: "requireRsi", label: "RSI 过滤" },
  { field: "minRsi", label: "RSI 下限" }, { field: "requireVegas", label: "Vegas 过滤" },
  { field: "entryAtDayCloseOnly", label: "仅收盘入场" },
];

export function reconciliationTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return;
  const time = Date.parse(/[Z+-]\d*:?\d*$/.test(value.slice(10)) ? value : `${value}Z`);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Parse only the complete Pine formats actually emitted by the 2H/4H scripts. */
export function parseTvStrategyKey(key: string, symbol: string, tf: LookbackTf): SignalComparableParameters | null {
  const p = key.split("|"), four = tf === "4h";
  if (p.length !== (four ? 12 : 11) || p[0] !== (four ? "aa-4h-v1" : "aa-2h-v1") ||
    !/^[A-Z0-9_]+:[A-Z][A-Z0-9.-]{0,15}$/.test(p[1]) || p[1].split(":")[1] !== symbol || p[2] !== (four ? "240" : "120")) return null;
  const numeric = (s: string) => /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(s) && Number.isFinite(Number(s));
  const offset = four ? 1 : 0;
  if (![p[3], p[4], p[8 + offset], ...(four ? [p[5]] : [])].every(numeric) || Number(p[3]) <= 0 || Number(p[4]) <= 0 || Number(p[8 + offset]) > 100 ||
    ![p[5 + offset], p[6 + offset], p[7 + offset], p[9 + offset], p[10 + offset]].every(s => s === "true" || s === "false")) return null;
  return { stopMult: Number(p[3]), trailMult: Number(p[4]), takeProfitR: four && Number(p[5]) > 0 ? Number(p[5]) : null,
    useBuy1: p[5 + offset] === "true", useBuy2: p[6 + offset] === "true", requireRsi: p[7 + offset] === "true",
    minRsi: Number(p[8 + offset]), requireVegas: p[9 + offset] === "true", entryAtDayCloseOnly: p[10 + offset] === "true" };
}

function trackingOf(book: LiveBookOk): SignalTracking | undefined {
  const value = book as LiveBookOk & { signalTracking?: SignalTracking; checkpoint?: { signalTracking?: SignalTracking } };
  return value.signalTracking ?? value.checkpoint?.signalTracking;
}

function parameterComparison(book: LiveBookOk, record: TvJournalEvidence, journal: TvJournalReadResult) {
  const saved = trackingOf(book)?.parameters as (SignalTracking["parameters"] & { entryAtDayCloseOnly?: boolean }) | undefined;
  const current = journal.parametersByTf?.[book.tf];
  const local = saved ? { ...saved, entryAtDayCloseOnly: saved.entryAtDayCloseOnly ?? current?.entryAtDayCloseOnly } : current;
  const tv = parseTvStrategyKey(record.strategyKey, record.symbol, record.tf);
  const differences: SignalParameterDifference[] = [];
  if (local && tv) for (const { field, label } of fields) {
    const left = local[field];
    if (left !== undefined && left !== tv[field]) differences.push({ field, label, local: left, tv: tv[field] });
  }
  return { differences, verified: !!local && !!tv && fields.every(({ field }) => local[field] !== undefined), current: !saved };
}

function localEntry(event: SignalExecutionEvent, tracking: SignalTracking) {
  const explicit = (event as SignalExecutionEvent & { entrySignalDate?: string | null }).entrySignalDate;
  const buy = event.type === "buy" ? event : tracking.events.find(e => e.type === "buy" && e.signalId === event.signalId);
  return { start: reconciliationTime(explicit ?? buy?.signalDate), close: reconciliationTime(buy?.signalTime) };
}

function rowForSignal(book: LiveBookOk, event: SignalExecutionEvent, record: TvJournalEvidence | undefined, journal: TvJournalReadResult, strong = false): SignalReconciliationRow {
  const row: SignalReconciliationRow = { id: `local:${book.tf}:${event.id}`, tf: book.tf, symbol: event.symbol, event: event.type === "buy" ? "buy" : "sell",
    evidence: "signal", status: "tv_record_not_found", summary: "已读取的 TV 档案中未找到对应记录；不能据此判断是否推送。",
    localSignalTime: reconciliationTime(event.signalTime), localPrice: event.signalPrice, parameterDifferences: [], differences: [] };
  if (!record) return row;
  const params = parameterComparison(book, record, journal);
  Object.assign(row, { tvSignalTime: record.signalTime, tvPrice: record.price, parameterDifferences: params.differences });
  const barStart = reconciliationTime(event.signalDate), tvStart = record.signalBarOpenTime;
  if (tvStart && barStart !== tvStart) row.differences.push("本地与 TV 的信号 K 线时间不同。");
  else if (row.localSignalTime !== record.signalTime) row.differences.push("本地收盘时间推算与 TV 记录时间不同，需核对交易时段。");
  if (Math.abs(event.signalPrice - record.price) > 0.011) row.differences.push("本地行情与 TV 的信号价格不同，需核对行情源和复权。");
  if (record.kind === undefined) row.differences.push("TV 留档缺少买点类型（一买/二买），无法核实原买点。");
  else if (record.kind !== event.kind) row.differences.push(`买点类型不同：本地${event.kind === 1 ? "一买" : "二买"}，TV ${record.kind === 1 ? "一买" : "二买"}。`);
  if (!params.verified) row.differences.push("策略签名格式或本地参数不完整，无法完整核对参数。");
  if (!strong || !tvStart) row.differences.push("缺少可核对的原始 K 线边界，时间对应关系尚未确认。");
  const actualDifference = (record.kind !== undefined && record.kind !== event.kind) || params.differences.length > 0 || (!!tvStart && tvStart !== barStart) || row.localSignalTime !== record.signalTime || Math.abs(event.signalPrice - record.price) > 0.011;
  row.status = actualDifference ? "different" : strong && !!tvStart && params.verified && record.kind !== undefined ? "matched" : "unverifiable";
  row.summary = row.status === "matched" ? "原买点、周期及已编码参数一致；账户是否成交另看执行原因。" : row.status === "different" ? "本地与 TV 记录存在差异，请分别核对参数、时间和价格。" : "找到候选记录，但证据不足以确认是同一组信号。";
  return row;
}

function rowForTv(book: LiveBookOk, record: TvJournalEvidence, records: TvJournalEvidence[], journal: TvJournalReadResult): SignalReconciliationRow {
  const tracking = trackingOf(book);
  const legacy = !tracking || record.entrySignalTime < (reconciliationTime(tracking.activatedAt) ?? tracking.activatedAt);
  const linked = records.find(r => r.id === record.id && r.tf === record.tf && r.symbol === record.symbol && r.entryTime);
  const entryTime = record.entryTime ?? linked?.entryTime;
  const fill = entryTime ? book.view.fills.find(f => f.side === "buy" && f.symbol === record.symbol && reconciliationTime(f.date) === entryTime) : undefined;
  const params = parameterComparison(book, record, journal);
  const differences: string[] = [];
  if (legacy) differences.push("该交易缺少本地原买点审计；成交时间不能替代信号时间。");
  if (params.current || legacy) differences.push("参数对比使用本地当前配置，不能据此还原历史配置。");
  if (!params.verified) differences.push("TV 策略签名或本地参数无法完整核对。");
  const entryPrice = record.entryPrice ?? linked?.entryPrice;
  const fillPriceDifferent = !!fill && entryPrice != null && Math.abs(fill.price - entryPrice) > 0.011;
  if (fillPriceDifferent) differences.push("账户成交价与 TV 入场价不同。");
  return { id: `tv:${record.event}:${record.id}`, tf: record.tf, symbol: record.symbol, event: record.event,
    evidence: legacy ? "account_fill" : "signal", status: params.differences.length || fillPriceDifferent ? "different" : legacy ? "unverifiable" : "local_record_not_found",
    summary: fill ? "账户成交时间与 TV 明确记录的入场时间对应；原买点是否一致尚无法确认。" : legacy ? "旧账本没有原买点审计，无法判断该 TV 信号是否曾被账户接受。" : "本地信号审计中未找到对应记录；尚不能据此判断成因。",
    tvSignalTime: record.signalTime, tvPrice: record.price, ...(fill ? { localFillTime: reconciliationTime(fill.date), localPrice: fill.price } : {}),
    ...(entryTime ? { tvEntryTime: entryTime } : {}), parameterDifferences: params.differences, differences };
}

/** Bounded, read-only comparison. Similar timestamps are candidates, never proof of identity. */
export function buildSignalReconciliation(cache: LiveBookCache, journal: TvJournalReadResult, now = new Date()): SignalReconciliationReport {
  const report: SignalReconciliationReport = { version: 1, generatedAt: now.toISOString(), asOf: cache.books.map(b => b.view.asOf).sort().at(-1) ?? cache.computedAt,
    availability: journal.availability, note: journal.reason ?? "对比已保存的 TV 档案与本地审计；未找到记录不等于漏推。价格差异不用于改写账户。",
    coverage: { from: journal.from, through: journal.through, tvRecords: journal.records.length, localEvents: 0,
      legacyTimeframes: cache.books.filter(b => !trackingOf(b)).map(b => b.tf), truncated: journal.truncated }, rows: [] };
  if (journal.availability === "unavailable") return report;
  for (const book of cache.books) {
    const tracking = trackingOf(book), records = journal.records.filter(r => r.tf === book.tf), used = new Set<TvJournalEvidence>();
    // An exit snapshot can use the corresponding archived entry's original bar boundary.
    const complete = records.map(r => ({ ...r, entrySignalBarOpenTime: r.entrySignalBarOpenTime ?? records.find(e => e.id === r.id && e.event === "buy")?.signalBarOpenTime }));
    const all = (tracking?.events ?? []).filter(e => e.type !== "account_exit" && (reconciliationTime(e.signalTime) ?? "") >= journal.from && (reconciliationTime(e.signalTime) ?? "") <= journal.through);
    const events = all.slice(-200); report.coverage.localEvents += events.length;
    if (events.length < all.length) report.coverage.truncated = true;
    for (const event of events) {
      const entry = localEntry(event, tracking!);
      const candidates = complete.filter(r => r.symbol === event.symbol && r.event === event.type && !used.has(r));
      const strong = candidates.filter(r => !!entry.start && r.entrySignalBarOpenTime === entry.start);
      const weak = candidates.filter(r => !!entry.close && r.entrySignalTime === entry.close);
      const nearby = candidates.filter(r => !!entry.close && Math.abs(Date.parse(r.entrySignalTime) - Date.parse(entry.close)) <= (book.tf === "4h" ? 4 : 2) * 3_600_000);
      const options = strong.length ? strong : weak.length ? weak : nearby;
      const parameterMatches = options.filter(r => { const p = parameterComparison(book, r, journal); return p.verified && !p.differences.length; });
      const matched = parameterMatches.length === 1 ? parameterMatches[0] : options.length === 1 ? options[0] : undefined;
      const row = rowForSignal(book, event, matched, journal, !!matched && strong.includes(matched));
      if (!matched && options.length > 1) { row.status = "unverifiable"; row.summary = "同一买点存在多份候选策略记录，未自动选择对应关系。"; }
      if (matched) used.add(matched);
      report.rows.push(row);
    }
    for (const record of complete) if (!used.has(record)) report.rows.push(rowForTv(book, record, complete, journal));
  }
  report.rows.sort((a, b) => (b.tvSignalTime ?? b.localSignalTime ?? "").localeCompare(a.tvSignalTime ?? a.localSignalTime ?? "") || a.id.localeCompare(b.id));
  if (report.rows.length > 100) { report.rows = report.rows.slice(0, 100); report.coverage.truncated = true; }
  return report;
}

/** Client-safe parser: copy only the documented, compact report fields. */
export function signalReconciliationReportOf(raw: unknown): SignalReconciliationReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as SignalReconciliationReport, c = r.coverage;
  if (r.version !== 1 || !reconciliationTime(r.generatedAt) || typeof r.asOf !== "string" || !Number.isFinite(Date.parse(r.asOf)) ||
    !["ok", "partial", "unavailable"].includes(r.availability) || typeof r.note !== "string" || !c ||
    !reconciliationTime(c.from) || !reconciliationTime(c.through) || !Number.isInteger(c.tvRecords) || c.tvRecords < 0 ||
    !Number.isInteger(c.localEvents) || c.localEvents < 0 || typeof c.truncated !== "boolean" || !Array.isArray(c.legacyTimeframes) ||
    c.legacyTimeframes.some(tf => tf !== "4h" && tf !== "2h") || !Array.isArray(r.rows) || r.rows.length > 100) return null;
  const rows: SignalReconciliationRow[] = [];
  for (const row of r.rows) {
    if (!row || typeof row.id !== "string" || !["2h", "4h"].includes(row.tf) || !/^[A-Z][A-Z0-9.-]{0,15}$/.test(row.symbol) ||
      !["buy", "sell"].includes(row.event) || !["matched", "different", "local_record_not_found", "tv_record_not_found", "unverifiable"].includes(row.status) ||
      !["signal", "account_fill"].includes(row.evidence) || typeof row.summary !== "string" || !Array.isArray(row.differences) || row.differences.some(d => typeof d !== "string") ||
      !Array.isArray(row.parameterDifferences) || row.parameterDifferences.some(d => !d || typeof d.field !== "string" || typeof d.label !== "string" ||
        [d.local, d.tv].some(v => v !== null && typeof v !== "string" && typeof v !== "boolean" && (typeof v !== "number" || !Number.isFinite(v))))) return null;
    const safe: SignalReconciliationRow = { id: row.id, tf: row.tf, symbol: row.symbol, event: row.event, status: row.status, evidence: row.evidence,
      summary: row.summary, differences: [...row.differences], parameterDifferences: row.parameterDifferences.map(({ field, label, local, tv }) => ({ field, label, local, tv })) };
    for (const field of ["localSignalTime", "tvSignalTime", "localFillTime", "tvEntryTime"] as const) if (row[field] != null) {
      const value = reconciliationTime(row[field]); if (!value) return null; safe[field] = value;
    }
    for (const field of ["localPrice", "tvPrice"] as const) if (row[field] != null) {
      if (!Number.isFinite(row[field]) || row[field]! <= 0) return null; safe[field] = row[field];
    }
    rows.push(safe);
  }
  return { version: 1, generatedAt: r.generatedAt, asOf: r.asOf, availability: r.availability, note: r.note,
    coverage: { from: c.from, through: c.through, tvRecords: c.tvRecords, localEvents: c.localEvents, legacyTimeframes: [...c.legacyTimeframes], truncated: c.truncated }, rows };
}
