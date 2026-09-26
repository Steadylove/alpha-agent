import { z } from "zod";
import { SECTOR_UNIVERSE } from "@/lib/scoring/sectorUniverse";
import type { CatalystEvent, CatalystReport, Relation, SourceHealth } from "./types";
import type { DailyReview } from "@/lib/review/types";

export type CatalystBriefItem = {
  id: string;
  subject: string;
  title: string;
  kind: "company" | "sector" | "market" | "upcoming";
  relation: "Portfolio" | "Signal" | "Sector" | "Market";
  sourceUrl: string;
  eventDate: string;
  timeLabel: string;
  priceChange: number | null;
  rpsChange: number | null;
  sectorRpsChange: number | null;
};
export type CatalystReviewDigest = {
  version: 1;
  reviewDate: string;
  reviewBuiltAt: string;
  capturedAt: string;
  revision?: number;
  originalCapturedAt?: string;
  supersedesCapturedAt?: string;
  sourceCoverage?: { id: string; label: string; state: SourceHealth["state"] }[];
  status: "ready" | "partial" | "unavailable";
  today: CatalystBriefItem[];
  upcoming: CatalystBriefItem[];
  warnings: string[];
};
export type CatalystReviewView = { status: "ready" | "missing" | "unavailable"; digest: CatalystReviewDigest | null };

const validDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const stampOf = (value: string | null | undefined): number | null => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const etDay = (value: number) => dayFormat.format(new Date(value));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const dayOfSource = (value: string): string | null => validDay(value) ? value : stampOf(value) != null ? etDay(stampOf(value)!) : null;
const rank = { Portfolio: 0, Signal: 1, Sector: 2, Market: 3 } as const;
const relationNames = { portfolio: "Portfolio", signal: "Signal", sector: "Sector", market: "Market" } as const;
const daySchema = z.string().refine(validDay);
const stampSchema = z.iso.datetime({ offset: true });
const urlSchema = z.string().max(2500).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && Boolean(url.hostname) &&
      !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname) &&
      ![...url.searchParams.keys()].some(key => /api.?key|token|secret|password|signature/i.test(key));
  } catch { return false; }
});
const itemSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/), subject: z.string().min(1).max(200), title: z.string().min(1).max(1000),
  kind: z.enum(["company", "sector", "market", "upcoming"]), relation: z.enum(["Portfolio", "Signal", "Sector", "Market"]),
  sourceUrl: urlSchema, eventDate: daySchema, timeLabel: z.string().min(1).max(160),
  priceChange: z.number().finite().nullable(), rpsChange: z.number().finite().min(-98).max(98).nullable(),
  sectorRpsChange: z.number().finite().min(-100).max(100).nullable(),
}).strict();
const digestSchema = z.object({
  version: z.literal(1), reviewDate: daySchema, reviewBuiltAt: stampSchema, capturedAt: stampSchema,
  revision: z.number().int().min(1).max(100000).optional(), originalCapturedAt: stampSchema.optional(), supersedesCapturedAt: stampSchema.optional(),
  sourceCoverage: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().max(200), state: z.enum(["ok", "partial", "unavailable", "disabled"]) }).strict()).max(60).optional(),
  status: z.enum(["ready", "partial", "unavailable"]), today: z.array(itemSchema).max(3), upcoming: z.array(itemSchema).max(3),
  warnings: z.array(z.string().min(1).max(1000)).max(10),
}).strict();

export function parseCatalystReviewDigest(raw: unknown, expectedDate: string, now = new Date()): CatalystReviewDigest {
  const digest = digestSchema.parse(raw), captured = Date.parse(digest.capturedAt);
  if (!validDay(expectedDate) || digest.reviewDate !== expectedDate || !Number.isFinite(now.getTime()) ||
      captured > now.getTime() + 60_000 || captured < Date.parse(digest.reviewBuiltAt) || etDay(captured) < digest.reviewDate) {
    throw new Error("Catalyst 补充日期或采集时间无效");
  }
  const original = stampOf(digest.originalCapturedAt), supersedes = stampOf(digest.supersedesCapturedAt);
  if (digest.revision != null && (original == null || original < Date.parse(digest.reviewBuiltAt) || original > captured ||
      digest.revision === 1 && (original !== captured || supersedes != null) ||
      digest.revision > 1 && (supersedes == null || supersedes < original || supersedes >= captured)) ||
      digest.revision == null && (original != null || supersedes != null) ||
      digest.sourceCoverage && new Set(digest.sourceCoverage.map(source => source.id)).size !== digest.sourceCoverage.length) {
    throw new Error("Catalyst 补充版本链无效");
  }
  const invalidUpcoming = (item: CatalystBriefItem) => item.kind !== "upcoming" || item.priceChange != null || item.rpsChange != null || item.sectorRpsChange != null ||
    item.eventDate < etDay(captured) || item.eventDate > etDay(captured + 72 * 3_600_000);
  if (new Set(digest.today.map(item => item.id)).size !== digest.today.length || new Set(digest.upcoming.map(item => item.id)).size !== digest.upcoming.length ||
      digest.upcoming.some(invalidUpcoming) || digest.today.filter(item => item.kind === "upcoming").length > 1 ||
      digest.today.some(item => item.kind !== "upcoming" ? item.eventDate !== digest.reviewDate :
        invalidUpcoming(item) || !digest.upcoming.some(upcoming => JSON.stringify(upcoming) === JSON.stringify(item))) ||
      digest.status === "unavailable" && (digest.today.length > 0 || digest.upcoming.length > 0)) {
    throw new Error("Catalyst 补充条目口径无效");
  }
  return digest;
}

/** ET bounds include DST transitions; they are never assigned as event times. */
function etBoundary(day: string, clock = "00:00"): number {
  const target = Date.parse(day + "T" + clock + ":00Z");
  let value = target;
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 4; i++) {
    const parts = format.formatToParts(new Date(value)), part = (kind: string) => parts.find(p => p.type === kind)?.value;
    const actual = Date.parse(part("year") + "-" + part("month") + "-" + part("day") + "T" + part("hour") + ":" + part("minute") + ":00Z");
    if (actual === target) return value;
    value += target - actual;
  }
  return NaN;
}
function futureWithinWindow(event: CatalystEvent, captured: number): boolean {
  if (event.status !== "scheduled" || event.timing === "unknown") return false;
  const end = captured + 72 * 3_600_000;
  if (event.timePrecision === "minute") {
    const at = stampOf(event.eventAt);
    return at != null && at > captured && at <= end && etDay(at) === event.eventDate;
  }
  if (!["date", "session"].includes(event.timePrecision) || !validDay(event.eventDate)) return false;
  const nextDay = new Date(Date.parse(event.eventDate + "T12:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  const upper = event.timePrecision === "session" && event.session === "pre" ?
    etBoundary(event.eventDate, "09:30") : etBoundary(nextDay);
  return etBoundary(event.eventDate) > captured && upper <= end;
}
function timeLabel(event: CatalystEvent, upcoming: boolean): string {
  const raw = upcoming ? event.eventAt : event.publishedAt, at = stampOf(raw);
  let label: string;
  if (event.timePrecision === "minute" && at != null) {
    label = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at)) + " ET" +
      (event.session === "pre" ? " · 盘前" : event.session === "after" ? " · 盘后" : "");
  } else {
    const session = event.timePrecision === "session" ? ({ pre: "盘前", regular: "常规时段", after: "盘后", closed: "休市时段", unknown: "" }[event.session]) : "";
    label = event.eventDate + (session ? " " + session + " · 具体时间待确认 ET" : " · 具体时间待确认 ET");
  }
  return label + (event.timing === "estimated" ? " · 预计" : "");
}
function sourceCurrent(source: SourceHealth | undefined, captured: number): boolean {
  return Boolean(source && ["ok", "partial"].includes(source.state) && stampOf(source.checkedAt) === captured);
}
/** Model-book CSV axes use an ET wall clock without an offset; other source timestamps do not. */
function portfolioMoment(value: string): { day: string; at: number | null } | null {
  if (validDay(value)) return { day: value, at: null };
  const floating = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  if (floating && validDay(floating[1])) return { day: floating[1], at: etBoundary(floating[1], floating[2] + ":" + floating[3]) + Number(floating[4] ?? 0) * 1000 };
  const at = stampOf(value);
  return at == null ? null : { day: etDay(at), at };
}
function material(event: CatalystEvent, relation: CatalystBriefItem["relation"]): boolean {
  if (!(event.importance === "high" || event.importance === "medium" && ["Portfolio", "Signal"].includes(relation))) return false;
  // CEO mentions and social-media commentary alone are not corporate catalysts.
  return event.type !== "Corporate" || /\b(appoint(?:s|ed|ment|ments)?|resign(?:s|ed|ation)?|step(?:s|ped)? down|retir(?:e[sd]?|ement)|restructur\w*|board (?:approv\w*|authoriz\w*)|leadership change|management change|ceo transition|layoffs?|job cuts?|workforce reduc\w*|plant (?:closure|shutdown)|divest\w*|nam(?:e[sd]?|ing) (?:a |its |new )?(?:ceo|cfo|chief executive|chief financial))\b|任命|辞任|辞职|退休|卸任|重组|董事会批准|高管变更|裁员|关停|剥离/i.test(event.title);
}
function currentRelation(event: CatalystEvent, report: CatalystReport, review: DailyReview, captured: number): CatalystBriefItem["relation"] | null {
  const acceptable = (relation: Relation): relation is Relation & { kind: keyof typeof relationNames } => {
    if (relation.kind === "opportunity" || stampOf(relation.observedAt) !== captured) return false;
    const portfolio = relation.kind === "portfolio" ? portfolioMoment(relation.asOf) : null;
    const asOf = relation.kind === "portfolio" ? portfolio?.day : dayOfSource(relation.asOf);
    if (!asOf || asOf > review.date || (portfolio?.at ?? stampOf(relation.asOf) ?? 0) > captured) return false;
    if (relation.kind === "market") return event.scope === "market" && relation.key === "market:US" && asOf === review.date;
    if (relation.kind === "sector") {
      const sector = report.universe.sectors.find(row => relation.key === "sector:" + row.id && event.sectorIds.includes(row.id));
      return Boolean(sector && asOf === review.date && dayOfSource(sector.asOf ?? report.universe.asOf) === review.date &&
        sourceCurrent(report.universe.health.find(source => source.id === "opportunity"), captured));
    }
    const object = report.universe.symbols.find(row =>
      (event.symbols.includes(row.symbol) || event.scope === "sector" && row.sectorId != null && event.sectorIds.includes(row.sectorId)) &&
      row.relations.some(current => current.kind === relation.kind && current.key === relation.key && current.asOf === relation.asOf && stampOf(current.observedAt) === captured));
    if (!object) return false;
    if (relation.kind === "portfolio") return asOf === review.date && Boolean(relation.tf) &&
      sourceCurrent(report.universe.health.find(source => source.id === "portfolio-" + relation.tf), captured);
    return asOf >= etDay(captured - 10 * 86_400_000) && ["signal-journal", "signal-live-archive"].some(id =>
      sourceCurrent(report.universe.health.find(source => source.id === id), captured));
  };
  return event.currentRelations.filter(acceptable).map(relation => relationNames[relation.kind]).sort((a, b) => rank[a] - rank[b])[0] ?? null;
}
type Candidate = { event: CatalystEvent; relation: CatalystBriefItem["relation"]; subject: string; etf: string | null; reactionSymbol: string | null };
function candidateOf(event: CatalystEvent, relation: CatalystBriefItem["relation"], report: CatalystReport): Candidate {
  const ids = event.scope === "stock" ? report.universe.symbols.filter(row => event.symbols.includes(row.symbol)).map(row => row.sectorId).filter((id): id is string => id != null) : event.sectorIds;
  const sectors = SECTOR_UNIVERSE.filter(sector => ids.includes(sector.id));
  const etf = sectors.length === 1 ? sectors[0].symbol : null;
  const symbols = [...event.symbols].sort(compare);
  return { event, relation, etf,
    subject: event.scope === "market" ? "Market" : event.scope === "sector" ? sectors.map(sector => sector.name + " · " + sector.symbol).join(" / ") || "Sector" : symbols.slice(0, 3).join(" / ") + (symbols.length > 3 ? " 等 " + symbols.length + " 个标的" : ""),
    reactionSymbol: event.scope === "market" ? "SPY" : event.scope === "sector" ? etf : event.symbols.length === 1 ? event.symbols[0] : null };
}
function brief(candidate: Candidate, report: CatalystReport, review: DailyReview, upcoming: boolean): CatalystBriefItem {
  const { event, subject, etf, reactionSymbol } = candidate;
  const reaction = report.reactions.find(row => row.eventId === event.id && row.symbol === reactionSymbol && row.asOf === review.date && row.anchorDate === review.date);
  const readyDay = (value: { date: string | null; value: number | null; status: string } | undefined, date: string | null) =>
    value != null && date != null && value.status === "ready" && value.date === date && finite(value.value);
  const before = reaction?.rps.before, after = reaction?.rps.after;
  const rpsReady = !upcoming && event.timePrecision === "minute" && reaction?.rps.metric === "composite-daily-sp500-v1" &&
    readyDay(before, review.previousDate) && readyDay(after, review.date) && before!.value! >= 1 && before!.value! <= 99 && after!.value! >= 1 && after!.value! <= 99;
  const sectorDelta = etf ? review.sectors.find(sector => sector.symbol === etf && sector.group === "sector")?.d1 : null;
  return { id: event.id, subject, title: event.title, kind: upcoming ? "upcoming" : event.scope === "stock" ? "company" : event.scope,
    relation: candidate.relation, sourceUrl: event.sourceUrl, eventDate: event.eventDate, timeLabel: timeLabel(event, upcoming),
    priceChange: !upcoming && event.timePrecision === "minute" && readyDay(reaction?.price.t0, review.date) ? reaction!.price.t0.value : null,
    rpsChange: rpsReady ? Math.round((after!.value! - before!.value!) * 100) / 100 : null,
    sectorRpsChange: !upcoming && finite(sectorDelta) && Math.abs(sectorDelta) <= 100 ? sectorDelta : null };
}
function uniqueCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = candidate.subject.toUpperCase() + "|" + candidate.event.type + "|" + candidate.event.title.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** The capture is independent and post-review; no claim these events were known at review.builtAt. */
export function buildCatalystReviewDigest(report: CatalystReport, review: DailyReview): CatalystReviewDigest {
  const captured = stampOf(report.generatedAt), built = stampOf(review.builtAt);
  if (report.version !== 1 || review.version !== 1 || !validDay(review.date) || report.asOf !== review.date ||
      captured == null || built == null || captured < built || etDay(captured) < review.date) throw new Error("Catalyst 补充必须匹配已生成复盘及其交易日");
  const sources = report.sources.filter(source => !source.id.startsWith("reaction-"));
  const usableSources = sources.filter(source => sourceCurrent(source, captured));
  const universeCurrent = stampOf(report.universe.observedAt) === captured;
  let invalid = 0;
  const candidates: Candidate[] = [];
  for (const event of report.events) {
    // Ordinary retained history outside this digest is not a collection failure.
    const relevant = event.status === "published" && event.eventDate === review.date || event.status === "scheduled" &&
      event.eventDate >= etDay(captured) && event.eventDate <= etDay(captured + 72 * 3_600_000);
    if (!relevant) continue;
    const first = stampOf(event.firstSeenAt), seen = stampOf(event.lastSeenAt), updated = stampOf(event.sourceUpdatedAt), publication = stampOf(event.publishedAt);
    // Published facts survive incremental polls; planned events need fresh confirmation.
    if (seen == null || seen > captured || first == null || first > seen || event.status === "scheduled" && seen !== captured ||
        event.sourceUpdatedAt != null && (updated == null || updated > captured) ||
        event.publishedAt != null && (publication == null || publication > captured) ||
        !sourceCurrent(sources.find(source => source.id === event.provider), captured) || !urlSchema.safeParse(event.sourceUrl).success) { invalid++; continue; }
    const relation = universeCurrent ? currentRelation(event, report, review, captured) : null;
    if (!relation || !material(event, relation)) continue;
    const candidate = candidateOf(event, relation, report);
    if (candidate.subject) candidates.push(candidate);
  }
  const priority = (a: Candidate, b: Candidate) => rank[a.relation] - rank[b.relation] ||
    Number(b.event.importance === "high") - Number(a.event.importance === "high");
  const upcoming = uniqueCandidates(candidates.filter(candidate => futureWithinWindow(candidate.event, captured))
    .sort((a, b) => priority(a, b) || compare(a.event.eventDate, b.event.eventDate) ||
      compare(a.event.eventAt ?? "", b.event.eventAt ?? "") || compare(a.event.id, b.event.id))).slice(0, 3)
    .map(candidate => brief(candidate, report, review, true));
  const published = uniqueCandidates(candidates.filter(({ event }) => event.status === "published" && event.eventDate === review.date &&
    (event.publishedAt == null || etDay(stampOf(event.publishedAt)!) === review.date))
    .sort((a, b) => priority(a, b) || compare(b.event.publishedAt ?? "", a.event.publishedAt ?? "") || compare(a.event.id, b.event.id)));
  const today = published.slice(0, upcoming.length ? 2 : 3).map(candidate => brief(candidate, report, review, false));
  if (upcoming[0]) today.push({ ...upcoming[0] });
  const coverage = [...report.sources, ...report.universe.health];
  const stalePortfolio = report.universe.symbols.some(row => row.relations.some(relation => relation.kind === "portfolio" &&
    (portfolioMoment(relation.asOf)?.day !== review.date || (portfolioMoment(relation.asOf)?.at ?? 0) > captured)));
  const limited = report.events.length >= 2500 || report.reactions.length >= 5000 || report.warnings.some(warning => /上限|截断|部分覆盖|字段或时间无效/.test(warning));
  const complete = sources.length > 0 && universeCurrent && !stalePortfolio && !limited && coverage.every(source => source.state === "ok" && stampOf(source.checkedAt) === captured) && invalid === 0;
  const status = usableSources.length === 0 ? "unavailable" : complete ? "ready" : "partial";
  const warnings = status === "unavailable" ? ["本轮事件来源不可用，不能判断是否存在重要催化。"] :
    status === "partial" ? ["本轮事件或对象覆盖不完整；空列表不代表没有重要催化。"] : [];
  if (invalid > 0) warnings.push("未沿用本轮未确认、时间异常或链接无效的事件。");
  if (limited) warnings.push("事件或反应存在处理上限或字段缺失，不能据空列表判断没有重要催化。");
  if (stalePortfolio) warnings.push("部分模型持仓日期尚未与本次复盘对齐，关联覆盖不完整。");
  return parseCatalystReviewDigest({ version: 1, reviewDate: review.date, reviewBuiltAt: review.builtAt, capturedAt: report.generatedAt,
    status, today, upcoming, warnings, sourceCoverage: coverage.map(({ id, label, state }) => ({ id, label, state })).sort((a, b) => compare(a.id, b.id)) }, review.date, new Date(captured));
}
