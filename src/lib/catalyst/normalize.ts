import { createHash } from "node:crypto";
import { z } from "zod";
import { EVENT_TYPES, type CatalystEvent, type CatalystReport, type CatalystUniverse, type EventInput } from "./types";
import { associateEvent } from "./universe";

export const etDay = (date: Date | string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(date));
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const day = z.string().refine(validDay);
const stamp = z.iso.datetime({ offset: true });
const safeUrl = z.string().max(2500).refine(s => {
  try { const u = new URL(s); return u.protocol === "https:" && !u.username && !u.password && !/^(localhost|127\.|10\.|192\.168\.|\[|169\.254\.)/i.test(u.hostname); } catch { return false; }
});
const symbol = z.string().regex(/^[A-Z][A-Z0-9.-]{0,14}$/);
const health = z.object({ id: z.string().max(100), label: z.string().max(200), state: z.enum(["ok", "partial", "unavailable", "disabled"]), checkedAt: stamp, count: z.number().int().nonnegative(), detail: z.string().max(1000) });
const relation = z.object({ kind: z.enum(["portfolio", "signal", "opportunity", "sector", "market"]), key: z.string().max(400), label: z.string().max(300), tf: z.enum(["2h", "4h"]).optional(), asOf: z.string().max(40), observedAt: stamp });
const signal = z.object({ id: z.string().max(400), symbol, tf: z.enum(["2h", "4h"]), event: z.enum(["buy", "sell"]), signalTime: stamp, capturedAt: stamp });
export const eventInputSchema = z.object({
  provider: z.string().min(1).max(80), externalId: z.string().min(1).max(500), sourceName: z.string().min(1).max(150), sourceUrl: safeUrl,
  title: z.string().min(1).max(1000), excerpt: z.string().max(2500), type: z.enum(EVENT_TYPES), importance: z.enum(["high", "medium", "low"]),
  symbols: z.array(symbol).max(100), sectorIds: z.array(z.string().max(40)).max(30), scope: z.enum(["stock", "sector", "market"]),
  publishedAt: stamp.nullable(), eventAt: stamp.nullable(), eventDate: day,
  timePrecision: z.enum(["minute", "session", "date", "unknown"]), session: z.enum(["pre", "regular", "after", "closed", "unknown"]),
  timing: z.enum(["confirmed", "estimated", "unknown"]), status: z.enum(["scheduled", "published", "cancelled"]), sourceUpdatedAt: stamp.nullable(),
});
const eventSchema = eventInputSchema.extend({ id: z.string().regex(/^[a-f0-9]{24}$/), firstSeenAt: stamp, lastSeenAt: stamp, revision: z.number().int().positive(), backfilled: z.boolean(), firstRelations: z.array(relation).max(500), currentRelations: z.array(relation).max(500), relatedSourceUrls: z.array(safeUrl).max(30) });
const observation = z.object({ date: day.nullable(), value: z.number().finite().nullable(), status: z.enum(["ready", "pending", "missing", "unavailable"]) }).refine(v => (v.status === "ready") === (v.value !== null) && (v.status !== "ready" || v.date !== null));
export const summarySchema = z.object({ generatedAt: stamp, inputHash: z.string().regex(/^[a-f0-9]{64}$/), model: z.string().max(100), sentences: z.array(z.object({ text: z.string().min(1).max(240), eventIds: z.array(z.string()).min(1).max(6) })).min(1).max(3) });
const reportSchema = z.object({
  version: z.literal(1), generatedAt: stamp, asOf: day.or(z.literal("")), sessions: z.array(day).max(30000),
  universe: z.object({ asOf: z.string(), observedAt: stamp, symbols: z.array(z.object({ symbol, name: z.string(), sectorId: z.string().nullable(), industry: z.string().nullable(), relations: z.array(relation) })).max(250), sectors: z.array(z.object({ id: z.string(), name: z.string(), etf: symbol, leader: z.boolean(), asOf: day.optional() })).max(30), signals: z.array(signal).max(10000), health: z.array(health).max(30) }),
  sources: z.array(health).max(30), events: z.array(eventSchema).max(3000),
  reactions: z.array(z.object({ eventId: z.string(), symbol, asOf: z.string(), anchorDate: day.nullable(), baseline: z.object({ date: day, close: z.number().positive() }).nullable(), basis: z.string(), price: z.object({ t0: observation, t1: observation, t3: observation, t5: observation }), rps: z.object({ metric: z.literal("composite-daily-sp500-v1"), before: observation, after: observation }), sector: z.object({ metric: z.literal("sector-etf-20d-excess-spy-v1"), etf: symbol.nullable(), before: observation, after: observation }), mfe: observation, mae: observation, signalsAfter: z.array(signal) })).max(6000),
  summary: summarySchema.nullable(), summaryStatus: z.enum(["ready", "stale", "unavailable", "not-requested"]), warnings: z.array(z.string().max(2000)).max(100),
});
export function parseCatalystReport(raw: unknown): CatalystReport {
  const r = reportSchema.parse(raw);
  const ids = new Set(r.events.map(e => e.id));
  if (ids.size !== r.events.length || r.events.some(e => e.firstSeenAt > e.lastSeenAt || Date.parse(e.lastSeenAt) > Date.parse(r.generatedAt)) || r.reactions.some(x => !ids.has(x.eventId))) throw new Error("事件归档关联无效");
  if (r.summary && r.summary.sentences.some(s => s.eventIds.some(id => !ids.has(id)))) throw new Error("事件解读引用无效");
  return r;
}

export function eventTier(event: Pick<CatalystEvent, "currentRelations">): number {
  const rank = { portfolio: 1, signal: 2, opportunity: 3, sector: 4, market: 5 };
  return Math.min(6, ...event.currentRelations.map(r => rank[r.kind]));
}

/** Provider identities preserve amendments; exact syndicated copies share provenance, never fuzzy-merge different events. */
export function mergeCatalystEvents(previous: CatalystEvent[], incoming: EventInput[], universe: CatalystUniverse, now: Date) {
  const at = now.toISOString();
  const map = new Map(previous.map(e => [e.id, { ...e, currentRelations: associateEvent(e, universe) }]));
  let rejected = 0;
  for (const input of incoming) {
    const parsed = eventInputSchema.safeParse(input);
    if (!parsed.success || (parsed.data.publishedAt && Date.parse(parsed.data.publishedAt) > now.getTime() + 60_000)) { rejected++; continue; }
    const e = parsed.data;
    const id = fingerprint([e.provider, e.externalId]).slice(0, 24);
    const old = map.get(id);
    const currentRelations = associateEvent(e, universe);
    if (!old && !currentRelations.length) continue;
    const changed = old && fingerprint(eventInputSchema.parse(old)) !== fingerprint(e);
    map.set(id, { ...e, id, firstSeenAt: old?.firstSeenAt ?? at, lastSeenAt: at, revision: old ? old.revision + Number(changed) : 1,
      backfilled: old?.backfilled ?? (e.status === "published" && (!e.publishedAt || etDay(e.publishedAt) < etDay(now))),
      firstRelations: old?.firstRelations ?? currentRelations, currentRelations, relatedSourceUrls: [...new Set([...(old?.relatedSourceUrls ?? []), e.sourceUrl])].slice(0, 30) });
  }
  const cutoff = new Date(now.getTime() - 45 * 86400000).toISOString().slice(0, 10);
  const grouped = new Map<string, CatalystEvent>();
  for (const e of [...map.values()].filter(e => e.eventDate >= cutoff).sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id))) {
    const key = fingerprint([e.title.trim().toLowerCase().replace(/\s+/g, " "), [...e.symbols].sort(), e.eventDate,
      e.publishedAt, e.eventAt, e.timePrecision, e.status, e.type]);
    const copy = grouped.get(key);
    if (!copy) grouped.set(key, e);
    else copy.relatedSourceUrls = [...new Set([...copy.relatedSourceUrls, ...e.relatedSourceUrls])].slice(0, 30);
  }
  const all = [...grouped.values()].sort((a, b) => b.eventDate.localeCompare(a.eventDate) || eventTier(a) - eventTier(b) || a.id.localeCompare(b.id));
  return { events: all.slice(0, 2500), rejected, truncated: all.length > 2500 };
}
