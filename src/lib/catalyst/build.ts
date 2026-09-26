import { existsSync, readFileSync, mkdirSync, writeFileSync, lstatSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { alpacaCredentials } from "@/lib/data-sources/alpaca";
import { readCsvPanel } from "@/lib/backtest/csvPanel";
import { csvDir, marketBaseUrl, rpsScaleFile, rpsSnapshotFile } from "@/lib/backtest/marketStore";
import type { PanelBars } from "@/lib/backtest/panel";
import type { RpsScaleFile } from "@/lib/backtest/rpsScale";
import { lastSettledNyDate } from "@/lib/backtest/mergeBars";
import { snapshotDir, snapshotFile } from "@/lib/vps/snapshot";
import { writeJsonAtomic } from "@/lib/files/atomicJson";
import { loadCatalystUniverse } from "./universe";
import { collectCatalystSources } from "./providers";
import { etDay, eventTier, fingerprint, mergeCatalystEvents, parseCatalystReport, validDay } from "./normalize";
import { calculateReaction, type ReactionInputs } from "./reaction";
import { catalystEvidence, generateCatalystSummary } from "./summary";
import type { CatalystEvent, CatalystReport, CatalystUniverse, ProviderResult, SourceHealth } from "./types";
import { publishCatalystReviewDigest } from "./reviewDigestStore";

const calendarSchema = z.object({ checkedAt: z.iso.datetime(), sessions: z.array(z.string().refine(validDay)).min(30), closes: z.record(z.string(), z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)) })
  .refine(value => value.sessions.every(day => value.closes[day] != null));
type Calendar = z.infer<typeof calendarSchema>;
type MarketInputs = ReactionInputs & { health: SourceHealth[] };
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const orderedDays = (days: string[]) => days.every((d, i) => validDay(d) && (!i || d > days[i - 1]));

/** Separate calendar cache preserves early closes; never changes the strategy's RPS calendar. */
async function reactionCalendar(now: Date): Promise<{ calendar: Calendar | null; health: SourceHealth }> {
  const file = path.join(path.dirname(snapshotDir()), ".catalyst", "calendar.json");
  const health: SourceHealth = { id: "reaction-calendar", label: "交易日历", state: "ok", checkedAt: now.toISOString(), count: 0, detail: "Alpaca 常规交易日及美东收盘时间。" };
  let cached: Calendar | null = null;
  try { cached = calendarSchema.parse(readJson(file)); if (!orderedDays(cached.sessions) || Date.parse(cached.checkedAt) > now.getTime()) cached = null; } catch { /* Refresh below. */ }
  if (cached && now.getTime() - Date.parse(cached.checkedAt) < 86400000 && Date.parse(cached.checkedAt) <= now.getTime() && cached.sessions.at(-1)! > etDay(now)) {
    return { calendar: cached, health: { ...health, count: cached.sessions.length, detail: `Alpaca 常规交易日及收盘时间；日历采于 ${cached.checkedAt}。` } };
  }
  try {
    const { key, secret } = alpacaCredentials();
    const base = key.startsWith("PK") ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
    const from = etDay(new Date(now.getTime() - 100 * 86400000)), to = etDay(new Date(now.getTime() + 45 * 86400000));
    const response = await fetch(`${base}/v2/calendar?start=${from}&end=${to}`, { headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret }, signal: AbortSignal.timeout(15000), cache: "no-store" });
    if (!response.ok) { await response.body?.cancel(); throw new Error("calendar unavailable"); }
    const rows = z.array(z.object({ date: z.string().refine(validDay), close: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) })).min(50).parse(await response.json());
    const calendar = calendarSchema.parse({ checkedAt: now.toISOString(), sessions: [...new Set(rows.map(r => r.date))].sort(), closes: Object.fromEntries(rows.map(r => [r.date, r.close])) });
    writeJsonAtomic(file, calendar);
    return { calendar, health: { ...health, count: rows.length } };
  } catch {
    // Retain a usable real calendar, never invent weekdays as exchange sessions.
    if (cached && cached.sessions.at(-1)! >= etDay(now)) return { calendar: cached, health: { ...health, state: "partial", count: cached.sessions.length, detail: `日历更新失败，沿用 ${cached.checkedAt} 的官方日历。` } };
    try {
      const raw = z.object({ calendar: z.object({ sessions: z.array(z.string().refine(validDay)) }) }).parse(readJson(rpsSnapshotFile()));
      if (!orderedDays(raw.calendar.sessions)) throw new Error();
      return { calendar: { ...raw.calendar, checkedAt: now.toISOString(), closes: {} }, health: { ...health, state: "partial", count: raw.calendar.sessions.length, detail: "仅有现网交易日日期；缺少收盘时刻，事件反应暂不计算。" } };
    } catch { return { calendar: null, health: { ...health, state: "unavailable", detail: "真实交易日历缺失，不能按自然日推算反应窗口。" } }; }
  }
}

export async function loadCatalystMarket(universe: CatalystUniverse, events: CatalystEvent[], now: Date): Promise<MarketInputs> {
  const { calendar, health: calendarHealth } = await reactionCalendar(now);
  const sessions = calendar?.sessions ?? [], panels = new Map<string, PanelBars>();
  const wanted = [...new Set(["SPY", ...universe.symbols.map(s => s.symbol), ...universe.sectors.map(s => s.etf), ...events.flatMap(e => e.symbols)])].slice(0, 500);
  for (const ticker of wanted) {
    try { const panel = readCsvPanel(csvDir("1d"), ticker); if (panel) panels.set(ticker, panel); } catch { /* Missing input is reported below and in each observation. */ }
  }
  const settled = lastSettledNyDate(new Date(now.getTime() - 20 * 60_000));
  const asOf = sessions.filter(d => d <= settled && panels.get("SPY")?.dates.includes(d)).at(-1) ?? "";
  const expected = sessions.filter(d => d <= settled).at(-1);
  let scale: RpsScaleFile | null = null;
  try {
    scale = z.object({ generatedAt: z.string(), index: z.string(), buckets: z.number(), dates: z.array(z.string().refine(validDay)), cuts: z.array(z.array(z.number().finite())), counts: z.array(z.number().int()) }).parse(readJson(rpsScaleFile()));
    if (!orderedDays(scale.dates) || scale.dates.length !== scale.cuts.length || scale.dates.length !== scale.counts.length || scale.buckets !== 99 ||
        scale.index !== "SP500" || !Number.isFinite(Date.parse(scale.generatedAt)) || Date.parse(scale.generatedAt) > now.getTime()) scale = null;
  } catch { scale = null; }
  const si = scale?.dates.indexOf(asOf) ?? -1;
  const scaleReady = scale != null && si >= 0 && scale.counts[si] >= 450 && scale.cuts[si].length === 99 && scale.cuts[si].every((cut, i, cuts) => !i || cut >= cuts[i - 1]);
  const completePrices = wanted.every(ticker => panels.get(ticker)?.dates.includes(asOf));
  const health: SourceHealth[] = [calendarHealth, { id: "reaction-prices", label: "日线反应数据", state: !asOf ? "unavailable" : !completePrices || asOf !== expected ? "partial" : "ok", checkedAt: now.toISOString(), count: panels.size,
    detail: `现有日线 CSV ${panels.size}/${wanted.length}；截至 ${asOf || "未知"}。非公告分钟行情；历史复权/来源变更可能影响研究值。` },
  { id: "reaction-rps", label: "日线 RPS 标尺", state: !scale ? "unavailable" : scaleReady ? "ok" : "partial", checkedAt: now.toISOString(), count: scale?.dates.length ?? 0,
    detail: "同口径重建每日标普相对强度；单日样本不足 450 或缺标尺时留空，不使用机会页 RPS50 替代。" }];
  return { universe, sessions, sessionCloses: calendar?.closes ?? {}, asOf, panels, scale, health };
}

export type BuildDependencies = {
  universe: typeof loadCatalystUniverse;
  collect: (universe: CatalystUniverse, now: Date) => Promise<ProviderResult[]>;
  market: typeof loadCatalystMarket;
  summarize: typeof generateCatalystSummary;
};

/** All external failures are isolated; this pipeline only owns snapshots/catalyst and .catalyst. */
export async function assembleCatalystReport(previous: CatalystReport | null, options: { now: Date; analyze?: boolean; apiKey?: string; model?: string }, deps: BuildDependencies): Promise<CatalystReport> {
  const { now } = options, universe = await deps.universe(now);
  const results = await deps.collect(universe, now);
  const merged = mergeCatalystEvents(previous?.events ?? [], results.flatMap(r => r.events), universe, now);
  const market = await deps.market(universe, merged.events, now);
  const ranked = [...merged.events].sort((a, b) => eventTier(a) - eventTier(b) || b.eventDate.localeCompare(a.eventDate));
  const reactions = ranked.filter(e => e.status === "published").flatMap(e => {
    const symbols = e.scope === "market" ? ["SPY"] : e.scope === "sector" && !e.symbols.length ? universe.sectors.filter(s => e.sectorIds.includes(s.id)).map(s => s.etf) : e.symbols;
    return symbols.slice(0, 5).map(symbol => {
      // Without real close times, holiday/early-close publication windows are ambiguous.
      const input = Object.keys(market.sessionCloses ?? {}).length ? market : { ...market, sessions: [] };
      const saved = previous?.reactions.find(p => p.eventId === e.id && p.symbol === symbol);
      const signals = [...new Map([...(saved?.signalsAfter ?? []), ...input.universe.signals].map(signal => [signal.id, signal])).values()];
      // Revalidate retained captures against the current publication/window; revisions can move the anchor.
      return calculateReaction(e, symbol, { ...input, universe: { ...input.universe, signals } });
    });
  }).slice(0, 5000);
  const ids = new Set(merged.events.map(e => e.id));
  const previousSummary = previous?.summary && previous.summary.sentences.every(s => s.eventIds.every(id => ids.has(id))) ? previous.summary : null;
  const report: CatalystReport = { version: 1, generatedAt: now.toISOString(), asOf: market.asOf, sessions: market.sessions, universe,
    sources: [...results.map(r => r.health), ...market.health], events: merged.events, reactions, summary: previousSummary, summaryStatus: previousSummary ? "stale" : "not-requested", warnings: [] };
  if (merged.rejected) report.warnings.push(`${merged.rejected} 条事件字段或时间无效，未采用。`);
  if (merged.truncated || reactions.length === 5000) report.warnings.push("事件或反应达到本轮处理上限，当前仅展示部分覆盖。" );
  const evidence = catalystEvidence(report, now), hash = fingerprint(evidence);
  const model = options.model || "deepseek-v4-pro";
  if (previousSummary?.inputHash === hash && (!options.analyze || previousSummary.model === model)) report.summaryStatus = "ready";
  else if (options.analyze && evidence.events.length) {
    if (!options.apiKey) { report.summaryStatus = previousSummary ? "stale" : "unavailable"; report.warnings.push("DeepSeek 事件解读尚未配置，事件数据仍可阅读。"); }
    else {
      try { report.summary = await deps.summarize(evidence, { apiKey: options.apiKey, model, now }); report.summaryStatus = "ready"; }
      catch { report.summaryStatus = previousSummary ? "stale" : "unavailable"; report.warnings.push("本轮事件解读未通过生成或引用校验，未作为当前结论展示。"); }
    }
  }
  return parseCatalystReport(report);
}

/** Only this module's generated regular files are eligible; never traverse links or unknown names. */
function pruneCatalystHistory(history: string, generatedAt: string, currentFile: string) {
  if (lstatSync(history).isSymbolicLink()) throw new Error("Catalyst history must be a real directory");
  const today = generatedAt.slice(0, 10);
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 44 * 86400000).toISOString().slice(0, 10);
  for (const entry of readdirSync(history, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validDay(entry.name) || entry.name > today) continue;
    const directory = path.join(history, entry.name);
    const candidates = readdirSync(directory, { withFileTypes: true }).flatMap(file => {
      const match = file.name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[a-f0-9]{12}\.json$/);
      if (!file.isFile() || !match || match[1] !== entry.name) return [];
      const stamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
      if (!Number.isFinite(Date.parse(stamp)) || new Date(stamp).toISOString() !== stamp) return [];
      const fullPath = path.join(directory, file.name);
      return [{ fullPath, stamp, modified: lstatSync(fullPath).mtimeMs }];
    }).sort((a, b) => b.stamp.localeCompare(a.stamp) || Number(b.fullPath === currentFile) - Number(a.fullPath === currentFile) || b.modified - a.modified || b.fullPath.localeCompare(a.fullPath));
    const expired = entry.name < cutoff ? candidates : candidates.slice(2);
    for (const file of expired) unlinkSync(file.fullPath);
    if (!readdirSync(directory).length) rmdirSync(directory);
  }
}

/** Validate, archive and publish first; only then prune to 45 UTC dates / two editions per date. */
export function saveCatalystReport(report: CatalystReport, directory = path.join(snapshotDir(), "catalyst")) {
  const checked = parseCatalystReport(report);
  const history = path.join(directory, "history"), archive = path.join(history, checked.generatedAt.slice(0, 10));
  if ([history, archive].some(folder => existsSync(folder) && lstatSync(folder).isSymbolicLink())) throw new Error("Catalyst 留档目录不能是符号链接");
  mkdirSync(archive, { recursive: true });
  const file = path.join(archive, `${checked.generatedAt.replace(/[:.]/g, "-")}-${fingerprint(checked).slice(0, 12)}.json`);
  try { writeFileSync(file, `${JSON.stringify(checked)}\n`, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  writeJsonAtomic(path.join(directory, "latest.json"), checked);
  try { pruneCatalystHistory(history, checked.generatedAt, file); }
  catch { throw new Error("Catalyst 最新快照已保存，但历史清理失败，请检查留档目录权限与磁盘空间"); }
}

export async function buildCatalystReport(options: { analyze?: boolean; dryRun?: boolean; refreshReviewDigest?: boolean } = {}) {
  if (marketBaseUrl()) throw new Error("Catalyst 采集必须在本地行情目录运行");
  if (options.dryRun) return { dryRun: true, rpsFile: existsSync(rpsSnapshotFile()), dailyData: existsSync(csvDir("1d")), saved: existsSync(snapshotFile("catalyst/latest")) };
  const file = snapshotFile("catalyst/latest");
  // Corrupt previous archives must not silently erase the observation history.
  const previous = existsSync(file) ? parseCatalystReport(readJson(file)) : null;
  const report = await assembleCatalystReport(previous, { now: new Date(), analyze: options.analyze,
    apiKey: process.env.DEEPSEEK_CATALYST_API_KEY || process.env.DEEPSEEK_REVIEW_API_KEY || process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_CATALYST_MODEL || process.env.DEEPSEEK_REVIEW_MODEL },
  { universe: loadCatalystUniverse, collect: collectCatalystSources, market: loadCatalystMarket, summarize: generateCatalystSummary });
  saveCatalystReport(report);
  const reviewDigest = publishCatalystReviewDigest(report, snapshotDir(), { refresh: options.refreshReviewDigest });
  const analysisFailed = Boolean(options.analyze && catalystEvidence(report, new Date(report.generatedAt)).events.length && report.summaryStatus !== "ready");
  return { generatedAt: report.generatedAt, events: report.events.length, reactions: report.reactions.length, summary: report.summaryStatus, analysisFailed, reviewDigest, sources: report.sources.map(s => ({ id: s.id, state: s.state, count: s.count })) };
}
