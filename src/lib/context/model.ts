import type { CatalystEvent, CatalystReport, SourceHealth, UniverseSignal } from "@/lib/catalyst/types";
import type { FlowEvent } from "@/lib/optionFlow/research/events";
import type { ContextCoverage, ContextEventEvidence, ContextFlowEvidence, ContextModelInput, ContextObservation, ContextReport, ContextSignalEvidence, ContextState, ContextTimelineItem } from "./types";

const timestamp = (value: unknown): number | null => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const etDay = (value: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const ticker = (value: string) => value.toUpperCase().replace(/^[A-Z]+:/, "").replace(/-/g, ".");
const validTicker = (value: string) => /^[A-Z][A-Z0-9.]{0,14}$/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const unavailable = (detail: string): ContextCoverage => ({ state: "unavailable", checkedAt: null, detail });
function safeUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 2500) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname) &&
      ![...url.searchParams.keys()].some(key => /token|password|secret|api.?key|signature/i.test(key)) ? value : null;
  } catch { return null; }
}
function sourceCoverage(sources: SourceHealth[], at: string, cutoff: number, detail: string): ContextCoverage {
  const usable = sources.filter(source => timestamp(source.checkedAt) != null && timestamp(source.checkedAt)! <= cutoff && ["ok", "partial"].includes(source.state));
  if (!usable.length) return unavailable(detail + "；来源未确认。");
  const fresh = timestamp(at) != null && cutoff - timestamp(at)! <= 2 * 3_600_000;
  // Health confirms collection succeeded, not that every item in an inferred date range was retrieved.
  return { state: "partial", checkedAt: at,
    detail: detail + "；来源健康不代表观察窗口完整覆盖。" + (fresh ? "" : "；快照已超过两小时。") };
}
function flowCoverage(input: ContextCoverage, cutoff: number): ContextCoverage {
  const at = timestamp(input.checkedAt);
  if (at == null || at > cutoff || !["ok", "partial"].includes(input.state)) return unavailable("期权流来源未确认，不能将缺失当作没有异常流。");
  return { state: cutoff - at > 2 * 3_600_000 ? "partial" : input.state, checkedAt: input.checkedAt,
    ...(input.from && validDay(input.from) ? { from: input.from } : {}), ...(input.through && validDay(input.through) ? { through: input.through } : {}),
    detail: input.detail.slice(0, 1000) };
}
/** This is a publication/relay session anchor, intentionally different from Catalyst's price T0. */
export function contextSessionAnchor(day: string, sessions: readonly string[]): string | null {
  if (!validDay(day) || !sessions.length || day < sessions[0] || !sessions.every((session, i) => validDay(session) && (!i || session > sessions[i - 1]))) return null;
  return sessions.find(session => session >= day) ?? null;
}
function versionTime(event: CatalystEvent): string | null {
  const raw = event as CatalystEvent & { evidenceUpdatedAt?: string | null };
  return raw.evidenceUpdatedAt ?? (event.revision === 1 ? event.firstSeenAt : null);
}
function portfolioTime(value: string): number | null {
  const absolute = timestamp(value);
  if (absolute != null) return absolute;
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
  if (!match || !validDay(match[1])) return null;
  const target = Date.parse(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  let result = target;
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(result));
    const p = (type: string) => parts.find(part => part.type === type)?.value;
    const seen = Date.parse(`${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}:00Z`);
    if (seen === target) return result + Number(match[4] ?? 0) * 1000;
    result += target - seen;
  }
  return null;
}
function evidenceWindowCovered(coverage: ContextCoverage, anchors: (string | null)[], sessions: string[], date: string): boolean {
  return coverage.state === "ok" && Boolean(coverage.from && coverage.through) && anchors.every(anchor => {
    const index = anchor ? sessions.indexOf(anchor) : -1;
    const from = sessions[index - 1], through = sessions[index + 1];
    return index > 0 && Boolean(through) && through <= date && coverage.from! <= from && coverage.through! >= through;
  });
}
function mature(anchors: (string | null)[], sessions: string[], date: string): boolean {
  return anchors.every(anchor => { const index = anchor ? sessions.indexOf(anchor) : -1; return index >= 0 && Boolean(sessions[index + 1]) && sessions[index + 1] <= date; });
}
const labels: Record<ContextState, string> = { "event-flow": "事件与异常流共现", "event-only": "样本内仅观察到事件", "flow-only": "样本内仅观察到异常流", insufficient: "证据覆盖不足", observing: "观察窗口内待匹配" };

/** Pure, bounded joining of observed facts. This module never produces scores or trading decisions. */
export function buildContextReport(input: ContextModelInput): ContextReport {
  const cutoff = timestamp(input.cutoff), generated = timestamp(input.generatedAt ?? input.cutoff);
  if (!validDay(input.date) || cutoff == null || generated == null || generated < cutoff || input.date > etDay(cutoff)) throw new Error("Context 日期或观察截止时间无效");
  const original = input.catalyst;
  const catalyst = original && original.asOf === input.date && timestamp(original.generatedAt) != null && timestamp(original.generatedAt)! <= cutoff ? original : null;
  const sessions = catalyst?.sessions && catalyst.sessions.every((day, i, days) => validDay(day) && (!i || day > days[i - 1])) && catalyst.sessions.includes(input.date) ? catalyst.sessions : [];
  const index = sessions.indexOf(input.date), firstDay = index >= 0 ? sessions[Math.max(0, index - 3)] : input.date;
  const warnings: string[] = [];
  if (!catalyst) warnings.push("缺少该观察日期及截止时刻之前的事件快照；未用最新事实重建历史。");
  if (!sessions.length) warnings.push("真实交易日历缺失，不能建立交易日窗口关联。");
  const eventProviders = new Set(catalyst?.events.filter(event => event.status === "published").map(event => event.provider));
  const eventSources = catalyst?.sources.filter(source => eventProviders.has(source.id) || /news|filing/i.test(source.id)) ?? [];
  const eventCoverage = catalyst ? sourceCoverage(eventSources, catalyst.generatedAt, cutoff, "仅限当前事件观察池及已配置发布来源") : unavailable("事件快照不可用。");
  const limited = Boolean(catalyst && (catalyst.events.length >= 2500 || catalyst.reactions.length >= 5000 || catalyst.warnings.some(warning => /上限|截断|部分覆盖|字段或时间无效/.test(warning))));
  if (limited && eventCoverage.state === "ok") eventCoverage.state = "partial";
  if (limited) warnings.push("事件归档存在处理上限或缺项，不能据空记录判断没有事件。");
  const flowsHealth = flowCoverage(input.flowCoverage, cutoff);
  const signalHealth = catalyst ? sourceCoverage(catalyst.universe.health.filter(source => /^signal-/.test(source.id)), catalyst.generatedAt, cutoff, "仅采用真实捕获信号，不含历史回放或券商成交") : unavailable("信号快照不可用。");
  const perSymbol = new Map<string, { events: ContextEventEvidence[]; flows: ContextFlowEvidence[] }>();
  const get = (symbol: string) => { let value = perSymbol.get(symbol); if (!value) { value = { events: [], flows: [] }; perSymbol.set(symbol, value); } return value; };
  let excluded = 0;
  for (const event of catalyst?.events ?? []) {
    if (event.status !== "published") continue;
    const published = timestamp(event.publishedAt), firstSeen = timestamp(event.firstSeenAt), lastSeen = timestamp(event.lastSeenAt), version = versionTime(event), updated = timestamp(version);
    const sourceUpdated = timestamp(event.sourceUpdatedAt);
    if (firstSeen == null || lastSeen == null || firstSeen > cutoff || firstSeen > lastSeen || lastSeen > cutoff ||
        event.publishedAt != null && (published == null || published > cutoff) || version != null && (updated == null || updated > cutoff) ||
        event.sourceUpdatedAt != null && (sourceUpdated == null || sourceUpdated > cutoff) || !safeUrl(event.sourceUrl)) { excluded++; continue; }
    const day = published == null ? event.eventDate : etDay(published), anchor = contextSessionAnchor(day, sessions);
    if ((anchor ?? day) < firstDay || (anchor ?? day) > input.date) continue;
    const evidence: ContextEventEvidence = { id: event.id, title: event.title.slice(0, 1000), type: event.type, sourceUrl: event.sourceUrl,
      publishedAt: event.publishedAt, firstSeenAt: event.firstSeenAt, updatedAt: version, eventDate: day, anchorDate: anchor,
      timePrecision: event.timePrecision, importance: event.importance, revision: event.revision, scope: event.scope, symbols: event.symbols };
    for (const symbol of new Set(event.symbols.map(ticker).filter(validTicker))) get(symbol).events.push(evidence);
  }
  for (const flow of flowsHealth.state !== "unavailable" ? input.flows : []) {
    const symbol = ticker(flow.ticker), posted = timestamp(flow.postedAt), firstSeen = timestamp(flow.firstObservedAt), updated = timestamp(flow.updatedAt);
    if (!validTicker(symbol) || posted == null || posted > cutoff || flow.firstObservedAt != null && (firstSeen == null || firstSeen > cutoff) ||
        flow.updatedAt != null && (updated == null || updated > cutoff) || firstSeen != null && updated != null && firstSeen > updated) { excluded++; continue; }
    const day = etDay(posted), anchor = contextSessionAnchor(day, sessions);
    if ((anchor ?? day) < firstDay || (anchor ?? day) > input.date) continue;
    const known = firstSeen != null && updated != null && Boolean(flow.provenance);
    get(symbol).flows.push({ id: flow.id, sourceUrl: safeUrl(flow.sourceUrl), postedAt: flow.postedAt,
      firstObservedAt: known ? flow.firstObservedAt! : null, updatedAt: known ? flow.updatedAt! : null, anchorDate: anchor,
      right: flow.right, side: flow.side, direction: flow.direction, premium: finite(flow.premium) && flow.premium! > 0 ? flow.premium : null,
      strike: finite(flow.strike) && flow.strike! > 0 ? flow.strike : null, expiry: flow.expiry?.slice(0, 80) ?? null,
      provenanceStatus: known ? "recorded" : "legacy-unknown", revision: flow.provenance?.revision ?? null,
      evidenceHash: flow.provenance?.evidenceHash ?? null, flags: flow.flags.slice(0, 8).map(flag => flag.slice(0, 200)) });
  }
  if (excluded) { warnings.push(`${excluded} 条证据存在未来时间、版本时间或来源字段异常，未采用。`); if (eventCoverage.state === "ok") eventCoverage.state = "partial"; if (flowsHealth.state === "ok") flowsHealth.state = "partial"; }
  const rawSignals = [...new Map([...(catalyst?.universe.signals ?? []), ...(catalyst?.reactions.flatMap(reaction => reaction.signalsAfter) ?? [])].map(signal => [signal.id, signal])).values()];
  const observations: ContextObservation[] = [];
  for (const [symbol, raw] of perSymbol) {
    const rowWarnings: string[] = [];
    const events = [...new Map(raw.events.map(event => [event.id, event])).values()].sort((a, b) => compare(b.publishedAt ?? b.eventDate, a.publishedAt ?? a.eventDate) || compare(a.id, b.id)).slice(0, 8);
    const flows = [...new Map(raw.flows.map(flow => [flow.id, flow])).values()].sort((a, b) => compare(b.postedAt, a.postedAt) || compare(a.id, b.id)).slice(0, 12);
    if (raw.events.length > events.length || raw.flows.length > flows.length) rowWarnings.push("该标的证据较多，详情仅展示有界的近期记录。");
    if (events.some(event => event.updatedAt == null) || flows.some(flow => flow.provenanceStatus === "legacy-unknown")) rowWarnings.push("部分旧记录缺少当前版本的首次可见时间，不能证明信号发生前已知。");
    const associations: ContextObservation["associations"] = [];
    for (const event of events) for (const flow of flows) {
      if (!event.anchorDate || !flow.anchorDate) continue;
      const distance = sessions.indexOf(flow.anchorDate) - sessions.indexOf(event.anchorDate);
      if (Math.abs(distance) <= 3) associations.push({ eventId: event.id, flowId: flow.id, sessionDistance: distance, window: Math.abs(distance) <= 1 ? "short" : "research" });
    }
    associations.sort((a, b) => Math.abs(a.sessionDistance) - Math.abs(b.sessionDistance) || compare(a.eventId, b.eventId) || compare(a.flowId, b.flowId));
    const monitored = catalyst?.universe.symbols.find(stock => ticker(stock.symbol) === symbol);
    const signals: ContextSignalEvidence[] = rawSignals.filter((signal: UniverseSignal) => {
      const at = timestamp(signal.signalTime), captured = timestamp(signal.capturedAt);
      return ticker(signal.symbol) === symbol && ["2h", "4h"].includes(signal.tf) && ["buy", "sell"].includes(signal.event) && at != null && captured != null &&
        at <= cutoff && captured <= cutoff && captured - at >= -60_000 && captured - at <= 900_000 && etDay(at) >= firstDay && etDay(at) <= input.date && sessions.includes(etDay(at));
    }).sort((a, b) => compare(b.signalTime, a.signalTime) || compare(a.id, b.id)).slice(0, 8).map(signal => ({
      id: signal.id, tf: signal.tf, event: signal.event, signalTime: signal.signalTime, capturedAt: signal.capturedAt,
      eventLinks: events.map(event => ({ eventId: event.id, knowledge: event.updatedAt == null || event.publishedAt == null ? "unknown" :
        Math.max(timestamp(event.firstSeenAt)!, timestamp(event.updatedAt)!, timestamp(event.publishedAt)!) <= timestamp(signal.signalTime)! ? "known-at-signal" : "observed-after-signal" })),
      flowLinks: flows.map(flow => ({ flowId: flow.id, knowledge: flow.firstObservedAt == null || flow.updatedAt == null ? "unknown" :
        Math.max(timestamp(flow.firstObservedAt)!, timestamp(flow.updatedAt)!, timestamp(flow.postedAt)!) <= timestamp(signal.signalTime)! ? "known-at-signal" : "observed-after-signal" })),
    }));
    const holdings: ContextObservation["trend"]["holdings"] = [];
    for (const relation of monitored?.relations ?? []) {
      const observed = timestamp(relation.observedAt), at = portfolioTime(relation.asOf), day = validDay(relation.asOf) ? relation.asOf : at != null ? etDay(at) : null;
      if (relation.kind !== "portfolio" || !relation.tf || day !== input.date || observed == null || observed > cutoff || at != null && at > cutoff ||
          !catalyst?.universe.health.some(source => source.id === `portfolio-${relation.tf}` && ["ok", "partial"].includes(source.state) && timestamp(source.checkedAt) != null && timestamp(source.checkedAt)! <= cutoff) ||
          holdings.some(item => item.tf === relation.tf)) continue;
      holdings.push({ tf: relation.tf, asOf: relation.asOf, observedAt: relation.observedAt, label: "当前模型持仓快照" });
    }
    const reaction = catalyst?.reactions.find(row => ticker(row.symbol) === symbol && row.asOf === input.date && row.rps.metric === "composite-daily-sp500-v1" &&
      row.rps.after.status === "ready" && row.rps.after.date === input.date && finite(row.rps.after.value) && row.rps.after.value >= 1 && row.rps.after.value <= 99);
    const rps: ContextObservation["trend"]["rps"] = reaction ? { metric: "composite-daily-sp500-v1", value: reaction.rps.after.value!, asOf: input.date, basis: "日线重建；非实时排名" } : null;
    let state: ContextState;
    if (associations.some(pair => pair.window === "short")) state = "event-flow";
    else if (!sessions.length || events.length && flowsHealth.state !== "ok" || flows.length && (eventCoverage.state !== "ok" || !monitored)) state = "insufficient";
    else if (events.length && !flows.length) state = evidenceWindowCovered(flowsHealth, events.map(event => event.anchorDate), sessions, input.date) ? "event-only" : mature(events.map(event => event.anchorDate), sessions, input.date) ? "insufficient" : "observing";
    else if (flows.length && !events.length) state = evidenceWindowCovered(eventCoverage, flows.map(flow => flow.anchorDate), sessions, input.date) ? "flow-only" : mature(flows.map(flow => flow.anchorDate), sessions, input.date) ? "insufficient" : "observing";
    else state = "observing";
    if (flows.length && !monitored) rowWarnings.push("该标的不在本次事件观察池，不能确认没有现实催化。");
    const summary = state === "event-flow" ? "同一标的的事件报道与异常流记录出现在前后一个交易日的窗口内；这只是样本内共现，不说明因果或交易方向。" :
      state === "event-only" ? "已覆盖的观察窗口内有事件，当前期权流样本未匹配到记录；不代表没有机构参与。" :
      state === "flow-only" ? "已覆盖的观察窗口内有异常流，当前事件来源未匹配到报道；不能称为资金提前布局。" :
      state === "insufficient" ? "已有部分观察，但来源、时间或交易日窗口覆盖不足，不能判定另一类证据不存在。" :
      "观察窗口尚未完整结束，或现有记录未形成短窗匹配；后续只补充已实际观察到的事实。";
    const trendParts = [...holdings.map(item => `${item.tf.toUpperCase()} 模型持仓`), ...new Set(signals.map(signal => `${signal.tf.toUpperCase()} ${signal.event === "buy" ? "买点" : "卖点"}记录`)), ...(rps ? [`日线 RPS ${rps.value}`] : [])];
    const timeline: ContextTimelineItem[] = [
      ...events.map(event => ({ id: `event:${event.id}`, track: "event" as const, at: event.publishedAt, observedAt: event.updatedAt, title: event.title,
        timeBasis: event.publishedAt ? "来源发表时间；系统首次记录与版本时间分别留档" : "仅有日期，不能判断分钟先后", sourceUrl: event.sourceUrl })),
      ...flows.map(flow => ({ id: `flow:${flow.id}`, track: "flow" as const, at: flow.postedAt, observedAt: flow.updatedAt, title: `${flow.side === "buyer" ? "Buy" : flow.side === "seller" ? "Sell" : "Unknown side"} ${flow.right}`,
        timeBasis: "来源消息或转发时间，不是交易所成交时间", sourceUrl: flow.sourceUrl })),
      ...signals.map(signal => ({ id: `signal:${signal.id}`, track: "trend" as const, at: signal.signalTime, observedAt: signal.capturedAt, title: `${signal.tf.toUpperCase()} ${signal.event === "buy" ? "买点" : "卖点"}真实捕获`, timeBasis: "系统信号记录，不代表券商成交", sourceUrl: null })),
      ...holdings.map(holding => ({ id: `holding:${holding.tf}:${symbol}`, track: "trend" as const, at: null, observedAt: holding.observedAt, title: `${holding.tf.toUpperCase()} 当前模型持仓`, timeBasis: `账本截至 ${holding.asOf}；不代表事件发生时持仓`, sourceUrl: null })),
      ...(rps ? [{ id: `rps:${symbol}:${rps.asOf}`, track: "trend" as const, at: null, observedAt: catalyst!.generatedAt, title: `日线 RPS ${rps.value}`, timeBasis: `截至 ${rps.asOf}；${rps.basis}`, sourceUrl: null }] : []),
    ].sort((a, b) => compare(b.at ?? b.observedAt ?? "", a.at ?? a.observedAt ?? "") || compare(a.id, b.id)).slice(0, 32);
    observations.push({ symbol, state, stateLabel: labels[state], summary, events, flows, associations: associations.slice(0, 32),
      trend: { status: trendParts.length ? "observed" : "unknown", label: trendParts.join(" · ") || "趋势证据未确认", signals, holdings, rps }, timeline, warnings: rowWarnings });
  }
  observations.sort((a, b) => Number(b.trend.holdings.length > 0) - Number(a.trend.holdings.length > 0) || Number(b.trend.signals.length > 0) - Number(a.trend.signals.length > 0) ||
    Number(b.state === "event-flow") - Number(a.state === "event-flow") || Number(b.events.some(event => event.importance === "high")) - Number(a.events.some(event => event.importance === "high")) || compare(a.symbol, b.symbol));
  if (observations.length > 100) warnings.push("关联标的超过页面上限，仅保留优先观察的 100 个标的。");
  const bounded = observations.slice(0, 100);
  return { version: 1, ruleVersion: "context-observation-v1", asOf: input.date, cutoff: input.cutoff, generatedAt: input.generatedAt ?? input.cutoff,
    sampleLabel: "非完整市场样本，仅用于辅助观察", coverage: { events: eventCoverage, flow: flowsHealth, signals: signalHealth },
    observations: bounded, highlights: bounded.slice(0, 3), summary: null, summaryStatus: "not-requested", warnings };
}
