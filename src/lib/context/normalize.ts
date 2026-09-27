import { z } from "zod";
import type { ContextReport } from "./types";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value);
const stamp = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(500);
const text = z.string().min(1).max(1000);
const url = z.string().max(2500).refine(value => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname) && ![...u.searchParams.keys()].some(key => /token|password|secret|api.?key|signature/i.test(key)); } catch { return false; }
});
const coverage = z.object({ state: z.enum(["ok", "partial", "unavailable"]), checkedAt: stamp.nullable(), from: day.optional(), through: day.optional(), detail: text });
const knowledge = z.enum(["known-at-signal", "observed-after-signal", "unknown"]);
const event = z.object({ id, title: text, type: z.string().min(1).max(100), sourceUrl: url, publishedAt: stamp.nullable(), firstSeenAt: stamp, updatedAt: stamp.nullable(),
  eventDate: day, anchorDate: day.nullable(), timePrecision: z.enum(["minute", "session", "date", "unknown"]), importance: z.enum(["high", "medium", "low"]), revision: z.number().int().positive() });
const flow = z.object({ id, sourceUrl: url.nullable(), postedAt: stamp, firstObservedAt: stamp.nullable(), updatedAt: stamp.nullable(), anchorDate: day.nullable(),
  right: z.enum(["call", "put"]), side: z.enum(["buyer", "seller", "unknown"]), direction: z.enum(["bull", "bear", "unknown"]),
  premium: z.number().finite().positive().nullable(), strike: z.number().finite().positive().nullable(), expiry: z.string().max(80).nullable(),
  provenanceStatus: z.enum(["recorded", "legacy-unknown"]), revision: z.number().int().positive().nullable(), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), flags: z.array(z.string().max(200)).max(8) });
const signal = z.object({ id, tf: z.enum(["2h", "4h"]), event: z.enum(["buy", "sell"]), signalTime: stamp, capturedAt: stamp,
  eventLinks: z.array(z.object({ eventId: id, knowledge })).max(8), flowLinks: z.array(z.object({ flowId: id, knowledge })).max(12) });
const observation = z.object({ symbol: z.string().regex(/^[A-Z][A-Z0-9.]{0,14}$/), state: z.enum(["event-flow", "event-only", "flow-only", "insufficient", "observing"]), stateLabel: text, summary: text,
  events: z.array(event).max(8), flows: z.array(flow).max(12), associations: z.array(z.object({ eventId: id, flowId: id, sessionDistance: z.number().int().min(-3).max(3), window: z.enum(["short", "research"]) })).max(32),
  trend: z.object({ status: z.enum(["observed", "unknown"]), label: text, signals: z.array(signal).max(8),
    holdings: z.array(z.object({ tf: z.enum(["2h", "4h"]), asOf: z.string().min(10).max(40), observedAt: stamp, label: z.literal("当前模型持仓快照") })).max(2),
    rps: z.object({ metric: z.literal("composite-daily-sp500-v1"), value: z.number().min(1).max(99), asOf: day, basis: z.literal("日线重建；非实时排名") }).nullable() }),
  timeline: z.array(z.object({ id, track: z.enum(["event", "flow", "trend"]), at: stamp.nullable(), observedAt: stamp.nullable(), title: text, timeBasis: text, sourceUrl: url.nullable() })).max(32),
  warnings: z.array(text).max(20) });
const schema = z.object({ version: z.literal(1), ruleVersion: z.literal("context-observation-v1"), asOf: day, cutoff: stamp, generatedAt: stamp,
  revision: z.number().int().positive().optional(), originalCapturedAt: stamp.optional(), supersedesCutoff: stamp.optional(),
  sampleLabel: z.literal("非完整市场样本，仅用于辅助观察"), coverage: z.object({ events: coverage, flow: coverage, signals: coverage }),
  observations: z.array(observation).max(100), highlights: z.array(observation).max(3),
  summary: z.object({ generatedAt: stamp, model: z.string().min(1).max(100), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    sentences: z.array(z.object({ text: z.string().min(1).max(240), evidenceIds: z.array(id).min(1).max(6) })).min(1).max(3) }).nullable(),
  summaryStatus: z.enum(["ready", "stale", "unavailable", "not-requested"]), warnings: z.array(text).max(30) });

/** Parses saved facts only. No regeneration, market lookup, or model call occurs on a page read. */
export function parseContextReport(raw: unknown, now = new Date()): ContextReport {
  const r = schema.parse(raw), cutoff = Date.parse(r.cutoff), generated = Date.parse(r.generatedAt);
  const beforeCutoff = (at: string | null) => at == null || Date.parse(at) <= cutoff;
  const fail = () => { throw new Error("Context 归档时间或证据关联无效"); };
  const etDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(cutoff));
  if (generated < cutoff || generated > now.getTime() + 60_000 || r.asOf > etDay ||
      r.originalCapturedAt && Date.parse(r.originalCapturedAt) > cutoff || r.supersedesCutoff && (Date.parse(r.supersedesCutoff) >= cutoff || (r.revision ?? 1) < 2)) fail();
  for (const c of Object.values(r.coverage)) if (!beforeCutoff(c.checkedAt) || c.state !== "unavailable" && c.checkedAt == null || c.from && c.through && c.from > c.through) fail();
  const symbols = new Set(r.observations.map(row => row.symbol));
  if (symbols.size !== r.observations.length || new Set(r.highlights.map(row => row.symbol)).size !== r.highlights.length ||
      r.highlights.some(row => JSON.stringify(row) !== JSON.stringify(r.observations.find(entry => entry.symbol === row.symbol)))) fail();
  const evidenceIds = new Set<string>();
  for (const row of r.observations) {
    const events = new Map(row.events.map(e => [e.id, e])), flows = new Map(row.flows.map(f => [f.id, f]));
    const expected = new Set([...events.keys()].map(key => `event:${key}`).concat([...flows.keys()].map(key => `flow:${key}`), row.trend.signals.map(s => `signal:${s.id}`), row.trend.holdings.map(h => `holding:${h.tf}:${row.symbol}`), row.trend.rps ? [`rps:${row.symbol}:${row.trend.rps.asOf}`] : []));
    if (events.size !== row.events.length || flows.size !== row.flows.length || new Set(row.trend.signals.map(s => s.id)).size !== row.trend.signals.length ||
        new Set(row.timeline.map(t => t.id)).size !== row.timeline.length || row.timeline.some(t => !expected.has(t.id) || !beforeCutoff(t.at) || !beforeCutoff(t.observedAt)) ||
        row.events.some(e => !beforeCutoff(e.publishedAt) || !beforeCutoff(e.firstSeenAt) || !beforeCutoff(e.updatedAt) || e.updatedAt && Date.parse(e.updatedAt) < Date.parse(e.firstSeenAt) || e.eventDate > r.asOf || e.anchorDate && e.anchorDate > r.asOf) ||
        row.flows.some(f => !beforeCutoff(f.postedAt) || !beforeCutoff(f.firstObservedAt) || !beforeCutoff(f.updatedAt) || f.anchorDate && f.anchorDate > r.asOf || f.provenanceStatus === "recorded" && (f.firstObservedAt == null || f.updatedAt == null || f.evidenceHash == null || f.revision == null) || f.firstObservedAt && f.updatedAt && Date.parse(f.firstObservedAt) > Date.parse(f.updatedAt)) ||
        row.associations.some(pair => !events.has(pair.eventId) || !flows.has(pair.flowId) || (Math.abs(pair.sessionDistance) <= 1) !== (pair.window === "short")) ||
        row.state === "event-flow" && !row.associations.some(pair => pair.window === "short") ||
        row.state === "event-only" && (!row.events.length || row.flows.length || r.coverage.flow.state !== "ok") ||
        row.state === "flow-only" && (!row.flows.length || row.events.length || r.coverage.events.state !== "ok") ||
        row.trend.holdings.some(h => !beforeCutoff(h.observedAt)) || row.trend.rps && row.trend.rps.asOf !== r.asOf) fail();
    for (const s of row.trend.signals) {
      const at = Date.parse(s.signalTime), lag = Date.parse(s.capturedAt) - at;
      if (!beforeCutoff(s.signalTime) || !beforeCutoff(s.capturedAt) || lag < -60_000 || lag > 900_000) fail();
      for (const link of s.eventLinks) {
        const e = events.get(link.eventId); if (!e) { fail(); continue; }
        const k = e.updatedAt == null || e.publishedAt == null ? "unknown" : Math.max(Date.parse(e.firstSeenAt), Date.parse(e.updatedAt), Date.parse(e.publishedAt)) <= at ? "known-at-signal" : "observed-after-signal";
        if (k !== link.knowledge) fail();
      }
      for (const link of s.flowLinks) {
        const f = flows.get(link.flowId); if (!f) { fail(); continue; }
        const k = f.firstObservedAt == null || f.updatedAt == null ? "unknown" : Math.max(Date.parse(f.firstObservedAt), Date.parse(f.updatedAt), Date.parse(f.postedAt)) <= at ? "known-at-signal" : "observed-after-signal";
        if (k !== link.knowledge) fail();
      }
    }
    row.timeline.forEach(t => evidenceIds.add(t.id));
  }
  if (r.summaryStatus === "ready" && !r.summary || r.summary && (Date.parse(r.summary.generatedAt) > generated || r.summary.sentences.some(sentence => sentence.evidenceIds.some(ref => !evidenceIds.has(ref))))) fail();
  return r;
}
