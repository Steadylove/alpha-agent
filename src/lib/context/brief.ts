import type { JournalSignal, Outcome } from "@/lib/review/types";
import type { ContextEventEvidence, ContextFlowEvidence, ContextObservation, ContextReport, ContextSignalEvidence } from "./types";

const eventNames: Record<string, string> = {
  Earnings: "财报与业绩", Guidance: "业绩指引", Corporate: "公司动态", Product: "产品进展",
  Regulatory: "监管进展", Legal: "诉讼进展", "M&A": "并购事项", "Capital / Financing": "融资事项",
  "FDA / Clinical": "临床与审批", Dividend: "分红事项", Buyback: "回购事项", "Lock-up": "限售解禁",
};
const roundup = /\b\d+\s+(?:[a-z-]+\s+){0,4}(?:stocks|sectors)\b|whale activity|unusual options|stocks? to watch|why .{0,80}stocks? (?:are|is)|market roundup|cathie wood|ark (?:loads|invest)|板块综述|异动汇总|值得关注的.{0,8}股/i;
const etDay = (stamp: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(stamp));
const validStamp = (stamp: string | null | undefined): stamp is string => Boolean(stamp && Number.isFinite(Date.parse(stamp)));

/** Editorial eligibility, not a trading score. Old archives retain their original facts. */
export function isMaterialContextEvent(event: ContextEventEvidence): boolean {
  return event.importance !== "low" && Boolean(eventNames[event.type]) && !roundup.test(event.title) &&
    (!event.scope || event.scope === "stock") && (!event.symbols || event.symbols.length <= 3);
}

export type ContextBriefItem = {
  observation: ContextObservation; event: ContextEventEvidence; flow: ContextFlowEvidence | null;
  signal: ContextSignalEvidence | null; kind: "event-flow-signal" | "event-signal" | "event-flow"; rank: number;
};

export function contextKnowledge(item: ContextBriefItem, track: "event" | "flow"): "known-at-signal" | "observed-after-signal" | "unknown" {
  if (!item.signal) return "unknown";
  const evidence = track === "event" ? item.event : item.flow;
  if (!evidence) return "unknown";
  const times = "publishedAt" in evidence ? [evidence.publishedAt, evidence.firstSeenAt, evidence.updatedAt]
    : [evidence.postedAt, evidence.firstObservedAt, evidence.updatedAt];
  if (("timePrecision" in evidence && evidence.timePrecision !== "minute") || !times.every(validStamp)) return "unknown";
  return Math.max(...times.map(time => Date.parse(time!))) <= Date.parse(item.signal.signalTime) ? "known-at-signal" : "observed-after-signal";
}

/** Select from all observations, not the legacy holding-first three highlights. */
export function selectContextBrief(report: ContextReport): ContextBriefItem[] {
  const items: ContextBriefItem[] = [];
  if (report.coverage.events.state === "unavailable") return items;
  for (const observation of report.observations) {
    const candidates: ContextBriefItem[] = [];
    for (const event of observation.events.filter(isMaterialContextEvent)) {
      const signals = report.coverage.signals.state === "unavailable" ? [] : observation.trend.signals.filter(signal =>
        validStamp(signal.signalTime) && event.anchorDate === etDay(signal.signalTime));
      const flows = report.coverage.flow.state === "unavailable" ? [] : observation.associations
        .filter(pair => pair.eventId === event.id && pair.window === "short" && Math.abs(pair.sessionDistance) <= 1)
        .flatMap(pair => observation.flows.filter(flow => flow.id === pair.flowId));
      const signal = [...signals].sort((a, b) => b.signalTime.localeCompare(a.signalTime))[0] ?? null;
      const flow = [...flows].sort((a, b) => b.postedAt.localeCompare(a.postedAt))[0] ?? null;
      if (!signal && !flow) continue;
      const kind = signal && flow ? "event-flow-signal" : signal ? "event-signal" : "event-flow";
      const item: ContextBriefItem = { observation, event, signal, flow, kind, rank: 0 };
      item.rank = (kind === "event-flow-signal" ? 30 : kind === "event-flow" ? 20 : 10) +
        Number(contextKnowledge(item, "event") === "known-at-signal") * 4 + Number(event.importance === "high") * 2;
      candidates.push(item);
    }
    candidates.sort((a, b) => b.rank - a.rank || b.event.eventDate.localeCompare(a.event.eventDate) || a.event.id.localeCompare(b.event.id));
    if (candidates[0]) items.push(candidates[0]);
  }
  return items.sort((a, b) => b.rank - a.rank || b.event.eventDate.localeCompare(a.event.eventDate) || a.observation.symbol.localeCompare(b.observation.symbol)).slice(0, 3);
}

/** Chinese topic + exact relation; never invent a translation or news outcome. */
export function contextBriefText(item: ContextBriefItem) {
  const topic = eventNames[item.event.type] ?? "公司消息";
  const relation = item.kind === "event-flow-signal" ? "报道与异常流在短窗内出现，同日也有系统信号。"
    : item.kind === "event-flow" ? "报道与异常流出现在前后一个交易日的窗口内。"
    : `报道与 ${item.signal!.tf.toUpperCase()} ${item.signal!.event === "buy" ? "买点" : "卖点"}记录出现在同一交易日。`;
  return { topic, text: `${topic}${relation}` };
}

export type ContextBriefMoment = { key: string; label: string; at: string | null; date: string; note: string; knowledge?: ReturnType<typeof contextKnowledge> };
export function contextBriefTimeline(item: ContextBriefItem): ContextBriefMoment[] {
  const result: ContextBriefMoment[] = [{ key: "event", label: "报道发布", at: item.event.timePrecision === "minute" ? item.event.publishedAt : null,
    date: item.event.eventDate, note: "来源发布时间", ...(item.signal ? { knowledge: contextKnowledge(item, "event") } : {}) }];
  if (item.flow) result.push({ key: "flow", label: "大单转述", at: item.flow.postedAt, date: etDay(item.flow.postedAt),
    note: "来源消息时间，非成交时间", ...(item.signal ? { knowledge: contextKnowledge(item, "flow") } : {}) });
  if (item.signal) result.push({ key: "signal", label: `${item.signal.tf.toUpperCase()} ${item.signal.event === "buy" ? "买点" : "卖点"}`, at: item.signal.signalTime,
    date: etDay(item.signal.signalTime), note: "系统信号，非券商成交" });
  return result.sort((a, b) => a.date.localeCompare(b.date) || (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : Number(!a.at) - Number(!b.at)));
}

export function contextBriefOutcome(item: ContextBriefItem, journal: readonly JournalSignal[], date: string): JournalSignal["outcomes"] | null {
  if (!item.signal || item.signal.event !== "buy") return null;
  const signal = item.signal;
  const row = journal.find(row => row.source === "live" && row.symbol === item.observation.symbol && row.tf === signal.tf &&
    row.signalTime === Date.parse(signal.signalTime) && Date.parse(row.capturedAt) <= Date.parse(signal.capturedAt));
  if (!row) return null;
  const bounded = (outcome: Outcome): Outcome => outcome.date && outcome.date > date ? { date: null, value: null, status: "pending" } : outcome;
  return { t1: bounded(row.outcomes.t1), t3: bounded(row.outcomes.t3), t5: bounded(row.outcomes.t5) };
}
