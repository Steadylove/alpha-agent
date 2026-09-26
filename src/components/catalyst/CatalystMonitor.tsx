"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, Activity, Radio, Link2 } from "lucide-react";
import { PageHeading } from "@/components/PageHeading";
import type { CatalystEvent, CatalystPageData, EventReaction, Importance, Observation, Relation, SourceHealth } from "@/lib/catalyst/types";
import s from "./catalyst.module.css";

export type CatalystCategory = "all" | Relation["kind"];
export type CatalystRange = "today" | "24h" | "3d" | "7d";
export type CatalystFilters = { category: CatalystCategory; range: CatalystRange; importance: "all" | Importance };
const categories: [CatalystCategory, string][] = [["all", "All"], ["portfolio", "Portfolio"], ["signal", "Signal"], ["opportunity", "Opportunity"], ["sector", "Sector"], ["market", "Market"]];
const ranges: [CatalystRange, string][] = [["today", "Today"], ["24h", "24H"], ["3d", "3D"], ["7d", "7D"]];
const kindLabel: Record<Relation["kind"], string> = { portfolio: "模型持仓", signal: "系统信号", opportunity: "机会观察", sector: "行业观察", market: "整体市场" };
const importanceLabel: Record<Importance, string> = { high: "HIGH", medium: "MEDIUM", low: "LOW" };
const sessionLabel: Record<CatalystEvent["session"], string> = { pre: "盘前", regular: "常规交易时段", after: "盘后", closed: "非交易时段", unknown: "时段待确认" };
const healthLabel: Record<SourceHealth["state"], string> = { ok: "采集正常", partial: "部分可用", unavailable: "暂不可用", disabled: "未启用" };
const timestamp = (value: string | null) => value && Number.isFinite(Date.parse(value)) ? `${new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value))} ET` : "时间未提供";
const nyDay = (value: string | number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
const numericTime = (value: string | null) => value ? Date.parse(value) : NaN;
const safeUrl = (value: string) => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { return null; } };
const eventStamp = (event: CatalystEvent) => event.publishedAt ?? (event.timePrecision === "minute" ? event.eventAt : null);
const eventDay = (event: CatalystEvent) => Number.isFinite(numericTime(eventStamp(event))) ? nyDay(eventStamp(event)!) : event.eventDate;
const priority = (event: CatalystEvent) => Math.min(5, ...event.currentRelations.map(r => categories.findIndex(([key]) => key === r.kind) - 1));

/** All clock comparisons use the saved collection cutoff, never the browser's local timezone. */
export function selectCatalystEvents(events: readonly CatalystEvent[], filters: CatalystFilters, cutoff: string, sessions: readonly string[], upcoming = false): CatalystEvent[] {
  const at = Date.parse(cutoff);
  if (!Number.isFinite(at)) return [];
  const today = nyDay(at), through = nyDay(at + 72 * 3_600_000);
  const days = [...new Set(sessions)].filter(day => day <= today).sort();
  const start = filters.range === "3d" ? days.at(-3) : filters.range === "7d" ? days.at(-7) : today;
  return events.filter(event => {
    if (filters.category !== "all" && !event.currentRelations.some(r => r.kind === filters.category)) return false;
    if (filters.importance !== "all" && event.importance !== filters.importance) return false;
    if (upcoming) {
      if (event.status !== "scheduled") return false;
      if (event.timePrecision === "minute" && Number.isFinite(numericTime(event.eventAt))) {
        const planned = numericTime(event.eventAt);
        return planned >= at && planned <= at + 72 * 3_600_000;
      }
      return event.eventDate >= today && event.eventDate <= through;
    }
    if (event.status === "scheduled") return false;
    const known = numericTime(eventStamp(event));
    if (Number.isFinite(known) && known > at) return false;
    const day = eventDay(event);
    if (filters.range === "24h") return Number.isFinite(known) && known >= at - 24 * 3_600_000;
    if (filters.range === "today") return day === today;
    return Boolean(start && day >= start && day <= today);
  }).sort((a, b) => upcoming ? a.eventDate.localeCompare(b.eventDate) || (a.eventAt ?? "").localeCompare(b.eventAt ?? "") || priority(a) - priority(b)
    : priority(a) - priority(b) || ["high", "medium", "low"].indexOf(a.importance) - ["high", "medium", "low"].indexOf(b.importance) || eventDay(b).localeCompare(eventDay(a)) || (eventStamp(b) ?? "").localeCompare(eventStamp(a) ?? ""));
}

export function eventTimeLabel(event: CatalystEvent): string {
  if (event.timePrecision === "minute" && event.eventAt && Number.isFinite(Date.parse(event.eventAt))) return timestamp(event.eventAt);
  return `${event.eventDate} · ${event.timePrecision === "session" ? sessionLabel[event.session] : "具体时间待确认"} · ET`;
}

function SectionTitle({ index, english, title, note }: { index: string; english: string; title: string; note: string }) {
  return <div className={s.sectionTitle}><div><span>{index} / {english}</span><h2>{title}</h2></div><p>{note}</p></div>;
}
function SourceLink({ url, children }: { url: string; children: React.ReactNode }) {
  const href = safeUrl(url);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={13} aria-hidden="true" /></a> : <span className={s.muted}>来源链接不可用</span>;
}
function Relations({ rows, empty = "暂无已核验关联" }: { rows: readonly Relation[]; empty?: string }) {
  return rows.length ? <div className={s.relations}>{rows.map((r, i) => <span key={`${r.kind}/${r.key}/${i}`} title={`对应数据 ${r.asOf}；观察于 ${timestamp(r.observedAt)}`}>{kindLabel[r.kind]}{r.tf ? ` · ${r.tf.toUpperCase()}` : ""}<small>{r.label}</small></span>)}</div> : <p className={s.muted}>{empty}</p>;
}
function EventEvidence({ event }: { event: CatalystEvent }) {
  return <details className={s.details}><summary>时间、来源与首次关联</summary><dl className={s.evidence}>
    <div><dt>事件时间</dt><dd>{eventTimeLabel(event)}{event.timing === "estimated" ? " · 预计，可能调整" : event.timing === "unknown" ? " · 尚未确认" : ""}</dd></div>
    <div><dt>来源发布</dt><dd>{timestamp(event.publishedAt)}</dd></div>
    <div><dt>系统首次发现</dt><dd>{timestamp(event.firstSeenAt)}{event.backfilled ? " · 历史补录" : ""}</dd></div>
    <div><dt>最近观察</dt><dd>{timestamp(event.lastSeenAt)} · 第 {event.revision} 版</dd></div>
    {event.sourceUpdatedAt && <div><dt>来源更新</dt><dd>{timestamp(event.sourceUpdatedAt)}</dd></div>}
    <div><dt>首次关联 · 已冻结</dt><dd><Relations rows={event.firstRelations} /></dd></div>
    <div><dt>当前关联</dt><dd><Relations rows={event.currentRelations} /></dd></div>
    {event.relatedSourceUrls.length > 0 && <div><dt>其他来源</dt><dd>{event.relatedSourceUrls.map(url => <SourceLink key={url} url={url}>原始记录</SourceLink>)}</dd></div>}
  </dl><p className={s.footnote}>首次关联保留当时已知对象；后续新增持仓或信号只更新当前关联。补录不代表事件当时已被系统看到。</p></details>;
}
function ObservationValue({ observation: o, unit = "%", signed = true }: { observation: Observation; unit?: string; signed?: boolean }) {
  const valid = o.status === "ready" && o.value != null && Number.isFinite(o.value);
  return <span className={s.observation}><strong className={valid && signed ? o.value! > 0 ? s.positive : o.value! < 0 ? s.negative : "" : ""}>{valid ? `${signed && o.value! > 0 ? "+" : ""}${o.value!.toFixed(unit ? 2 : 1)}${unit}` : o.status === "pending" ? "待成熟" : o.status === "unavailable" ? "来源不可用" : "缺数据"}</strong><small>{o.date ?? "日期待确认"}</small></span>;
}
function ReactionCard({ reaction: r, event }: { reaction: EventReaction; event: CatalystEvent }) {
  return <article className={s.reaction}>
    <div className={s.reactionHeading}><div><Link href={`/desk?q=${encodeURIComponent(r.symbol)}`} className={s.symbol}>{r.symbol}<ArrowUpRight size={15} aria-hidden="true" /></Link><div className={s.eventAnchor}><SourceLink url={event.sourceUrl}>{event.title}</SourceLink></div></div><span>行情截至 {r.asOf}</span></div>
    <div className={s.baseline}>{r.baseline ? <>基准：{r.baseline.date} 前收盘 <b>${r.baseline.close.toFixed(2)}</b></> : "前收盘基准缺失"}<span>T0 {r.anchorDate ?? "待确认"}</span></div>
    <dl className={s.priceGrid}>{(["t0", "t1", "t3", "t5"] as const).map((key, i) => <div key={key}><dt>{["T0 收盘", "T+1", "T+3", "T+5"][i]}</dt><dd><ObservationValue observation={r.price[key]} /></dd></div>)}</dl>
    <div className={s.comparisons}>
      <div><h4>个股日线 RPS</h4><div className={s.beforeAfter}><ObservationValue observation={r.rps.before} unit="" signed={false} /><span aria-label="变化至">→</span><ObservationValue observation={r.rps.after} unit="" signed={false} /></div><p>标普参照 · 历史日线与当日标尺重建</p></div>
      <div><h4>板块 20 日超额 · {r.sector.etf ?? "未匹配"}</h4><div className={s.beforeAfter}><ObservationValue observation={r.sector.before} unit=" pp" /><span aria-label="变化至">→</span><ObservationValue observation={r.sector.after} unit=" pp" /></div><p>ETF 相对 SPY，单位百分点；不是板块 RPS</p></div>
    </div>
    <details className={s.details}><summary>后续波动与真实信号 <span>{r.signalsAfter.length} 条 · 近 10 天实收范围</span></summary>
      <div className={s.excursions}><div><span>MFE · 最大有利变动</span><ObservationValue observation={r.mfe} /></div><div><span>MAE · 最大不利变动</span><ObservationValue observation={r.mae} /></div></div>
      <p className={s.footnote}>仅计算 T+1 至 T+5 的高低价相对同一基准的变动，排除 T0；不是实际持仓收益。</p>
      {r.signalsAfter.length ? <ul className={s.signalList}>{r.signalsAfter.map(signal => <li key={signal.id}><b>{signal.symbol}</b><span>{signal.tf.toUpperCase()} · {signal.event === "buy" ? "买点" : "卖点"}</span><span>{timestamp(signal.signalTime)}</span><small>实收 {timestamp(signal.capturedAt)}</small></li>)}</ul> : <p className={s.muted}>当前归档未关联到事件后的实收信号；不能据此认定系统从未产生信号。</p>}
      <p className={s.footnote}>信号关联仅检查采集截止前近 10 天实收的买卖点，再筛选事件之后的记录；不代表完整历史信号库。</p><p className={s.footnote}>{r.basis}</p>
    </details>
  </article>;
}

export function CatalystMonitor({ report: r, error, stale }: CatalystPageData) {
  const [filters, setFilters] = useState<CatalystFilters>({ category: "all", range: "3d", importance: "all" });
  const [eventLimit, setEventLimit] = useState(12);
  const [reactionLimit, setReactionLimit] = useState(6);
  const changeFilters = (next: CatalystFilters) => {
    setFilters(next);
    setEventLimit(12);
    setReactionLimit(6);
  };
  const upcoming = r ? selectCatalystEvents(r.events, filters, r.generatedAt, r.sessions, true) : [];
  const recent = r ? selectCatalystEvents(r.events, filters, r.generatedAt, r.sessions) : [];
  const eventById = new Map(recent.map(event => [event.id, event]));
  const reactions = r?.reactions.filter(reaction => eventById.has(reaction.eventId)) ?? [];
  const coverage = r?.sources.filter(source => source.state === "ok").length ?? 0;
  const related = [...new Map([...upcoming, ...recent].map(event => [event.id, event])).values()];
  return <div className={s.root}>
    <PageHeading eyebrow="REALITY LAYER" title="事件与现实催化剂" english="Catalyst Monitor" description="先记录现实发生了什么，再观察市场留下怎样的变化。" />
    {error && <p role="alert" className={s.notice}>{error}</p>}
    {stale && r && <p role="status" className={s.notice}>当前为上次采集的留档，尚未更新至最新。下方时间窗口以 {timestamp(r.generatedAt)} 为截止。</p>}
    {!r ? <div className={s.empty}><Radio size={25} aria-hidden="true" /><h2>等待事件数据归档</h2><p>尚无可读取的事件快照，来源覆盖与市场反应暂不可判断。</p><p>采集任务完成后展示真实记录；刷新页面只读取已保存结果。</p></div> : <>
      <div className={s.statusBar}><span><Radio size={13} aria-hidden="true" />采集 {timestamp(r.generatedAt)}</span><span>日线行情截至 {r.asOf || "尚未提供"}</span><a href="#catalyst-sources">正常来源 {coverage} / {r.sources.length}<ArrowUpRight size={12} aria-hidden="true" /></a></div>
      <div className={s.summary}><span className={s.eyebrow}>CATALYST SUMMARY</span>{r.summaryStatus === "ready" && r.summary ? <><div>{r.summary.sentences.map((sentence, i) => <p key={i}>{sentence.eventIds.reduce((text, id, index) => text.replaceAll(id, `[${index + 1}]`), sentence.text)}<span className={s.citations}>{sentence.eventIds.flatMap((id, n) => { const evidence = r.events.find(event => event.id === id); return evidence ? [<SourceLink key={id} url={evidence.sourceUrl}>[{n + 1}]</SourceLink>] : []; })}</span></p>)}</div><small>{r.summary.model} · 生成于 {timestamp(r.summary.generatedAt)} · 仅解释已收录事实</small></> : <p className={s.summaryPending}>{r.summaryStatus === "stale" ? "事件资料已更新，上一版摘要不再展示，等待重新生成。" : r.summaryStatus === "unavailable" ? "AI 摘要暂不可用，已核验的事件与行情仍可查看。" : "尚未生成本次事件摘要。"}</p>}</div>
      <nav className={s.sectionNav} aria-label="事件页面目录"><a href="#catalyst-calendar"><CalendarDays size={16} />未来事件<span>{upcoming.length}</span></a><a href="#catalyst-events"><Radio size={16} />近期事件<span>{recent.length}</span></a><a href="#catalyst-reactions"><Activity size={16} />市场反应<span>{reactions.length}</span></a><a href="#catalyst-universe"><Link2 size={16} />我的观察对象</a></nav>
      <div className={s.filters}><fieldset><legend>关联对象</legend><div className={s.pills}>{categories.map(([value, label]) => <button key={value} type="button" aria-pressed={filters.category === value} onClick={() => changeFilters({ ...filters, category: value })}>{label}</button>)}</div></fieldset><div className={s.filterBottom}><fieldset><legend>已发生事件的回看范围</legend><div className={s.pills}>{ranges.map(([value, label]) => <button key={value} type="button" aria-pressed={filters.range === value} onClick={() => changeFilters({ ...filters, range: value })}>{label}</button>)}</div></fieldset><label className={s.importance}>重要性<select value={filters.importance} onChange={e => changeFilters({ ...filters, importance: e.target.value as CatalystFilters["importance"] })}><option value="all">All importance</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label></div><p>时间截止于本次采集。Today 按美东日期，24H 按来源发布时间；3D / 7D 按交易日日历回看。未来事件固定为未来 72 小时。Signal 关联近 10 天实收买卖点。</p></div>
      {!r.sessions.length && <p className={s.notice}>交易日日历缺失，3D / 7D 暂不展示记录；可切换 Today / 24H 查看可确认时间的事件。</p>}
      {filters.range === "24h" && <p className={s.footnote}>没有精确发布时间的记录不进入 24H 筛选，可在交易日范围中查看。</p>}
      <section id="catalyst-calendar" className={s.section}><SectionTitle index="01" english="UPCOMING CALENDAR" title="未来 72 小时" note="只记录日程；重要性不表示涨跌方向。" />
        <div className={s.calendar}>{upcoming.map(event => <article className={s.calendarItem} key={event.id} id={`event-${event.id}`}><div className={s.calendarDate}><CalendarDays size={17} aria-hidden="true" /><strong>{event.eventDate.slice(5).replace("-", "/")}</strong><span className={s.importanceBadge} data-level={event.importance}>{importanceLabel[event.importance]}</span></div><p className={s.eventTime}>{eventTimeLabel(event)}{event.timing === "estimated" ? " · 预计" : ""}</p><h3>{event.title}</h3><div className={s.eventMeta}><span>{event.type}</span><span>{event.symbols.join(" / ") || "市场 / 行业"}</span></div><Relations rows={event.currentRelations} /><SourceLink url={event.sourceUrl}>{event.sourceName}</SourceLink><EventEvidence event={event} /></article>)}</div>
        {!upcoming.length && <div className={s.sectionEmpty}>当前筛选下未收录未来 72 小时的相关日程。请同时查看来源覆盖，空列表不代表没有事件。</div>}
        <p className={s.footnote}>仅有日期或时段的事件按美东日期纳入，72 小时边界尚待精确时间确认。预计日程可能调整；计划时间经过不等于结果已经发布。</p>
      </section>
      <section id="catalyst-events" className={s.section}><SectionTitle index="02" english="RECENT EVENTS" title="最近发生了什么" note="优先展示模型持仓，再看信号、机会、行业与市场。" />
        <div className={s.eventList}>{recent.slice(0, eventLimit).map(event => <article className={s.eventItem} key={event.id} id={`event-${event.id}`}><div className={s.eventAside}><strong>{event.symbols.join(" / ") || (event.scope === "market" ? "MARKET" : "SECTOR")}</strong><span>{event.type}</span><span className={s.importanceBadge} data-level={event.importance}>{importanceLabel[event.importance]}</span></div><div><div className={s.eventMeta}><span>{eventTimeLabel(event)}</span>{event.session !== "unknown" && <span>{sessionLabel[event.session]}</span>}{event.status === "cancelled" && <span className={s.warning}>日程已取消</span>}{event.backfilled && <span>历史补录</span>}</div><h3>{event.title}</h3>{event.excerpt && <p className={s.excerpt}>{event.excerpt}</p>}<Relations rows={event.currentRelations} /><div className={s.sourceRow}><SourceLink url={event.sourceUrl}>{event.sourceName} · 原始来源</SourceLink><span>发布 {timestamp(event.publishedAt)}</span></div><EventEvidence event={event} /></div></article>)}</div>
        {recent.length > 0 && <div className={s.moreRows}><span aria-live="polite">已展示 {Math.min(eventLimit, recent.length)} / {recent.length} 条事件</span>{recent.length > eventLimit && <button type="button" onClick={() => setEventLimit(limit => limit + 12)}>再看 12 条事件</button>}</div>}
        {!recent.length && <div className={s.sectionEmpty}>当前范围未收录符合筛选条件的事件。来源未启用、采集缺失与没有重要事件是不同状态。</div>}
      </section>
      <section id="catalyst-reactions" className={s.section}><SectionTitle index="03" english="EVENT → REACTION" title="市场实际发生了怎样的变化" note="日线观察 · T0 / T+1 / T+3 / T+5" /><p className={s.methodLead}>价格以 T0 前一交易日收盘为基准，盘后发布的事件从下一交易日开始观察。窗口涨跌可能包含公告前的价格变化，不能解释为即时反应或事件造成的收益。</p>
        <div className={s.reactionList}>{reactions.slice(0, reactionLimit).map(reaction => <ReactionCard key={`${reaction.eventId}/${reaction.symbol}`} reaction={reaction} event={eventById.get(reaction.eventId)!} />)}</div>
        {reactions.length > 0 && <div className={s.moreRows}><span aria-live="polite">已展示 {Math.min(reactionLimit, reactions.length)} / {reactions.length} 个反应记录</span>{reactions.length > reactionLimit && <button type="button" onClick={() => setReactionLimit(limit => limit + 6)}>再看 6 个反应记录</button>}</div>}
        {!reactions.length && <div className={s.sectionEmpty}>当前事件尚无可展示的个股反应记录。计划事件未发生，或仍在等待可用行情；不会填入示例数据。</div>}
        <p className={s.footnote}>所有窗口使用真实交易日；RPS 与板块值只在已收盘日线更新后变化，不是盘中实时排名。缺数据与尚未成熟分别显示。</p>
      </section>
      <section id="catalyst-universe" className={s.section}><SectionTitle index="04" english="MY UNIVERSE" title="把事件放回自己的观察范围" note={`对象快照截至 ${r.universe.asOf} · ${r.universe.symbols.length} 个标的`} /><div className={s.universe}>{categories.slice(1).map(([kind, label]) => { const events = related.filter(event => event.currentRelations.some(relation => relation.kind === kind)); const labels = [...new Set(events.flatMap(event => event.currentRelations.filter(relation => relation.kind === kind).map(relation => `${relation.label}${relation.tf ? ` · ${relation.tf.toUpperCase()}` : ""}`)))]; return <article key={kind}><span className={s.eyebrow}>{label}</span><h3>{kindLabel[kind as Relation["kind"]]}<span>{events.length}</span></h3><p>{labels.slice(0, 8).join(" / ") || "当前筛选下暂无已关联事件"}{labels.length > 8 ? ` 等 ${labels.length} 项` : ""}</p></article>; })}</div><p className={s.footnote}>Portfolio 指 2H / 4H 模型账户持仓。这里只连接事实与观察对象，事件不直接调整买点评分、持仓、止损或止盈。</p>
        <details className={s.watchlist}><summary>查看全部监测标的<span>{r.universe.symbols.length} 个 · 包含尚无事件的标的</span></summary><p className={s.footnote}>完整对象快照，不受上方事件筛选影响。被监测表示属于当前观察范围，不代表已经收录相关事件或覆盖全部公告。</p><div className={s.watchGrid}>{r.universe.symbols.map(stock => <article key={stock.symbol}><div><Link href={`/desk?q=${encodeURIComponent(stock.symbol)}`}>{stock.symbol}<ArrowUpRight size={12} aria-hidden="true" /></Link><span>{stock.name}</span></div><p>{r.universe.sectors.find(sector => sector.id === stock.sectorId)?.name ?? stock.sectorId ?? "板块待分类"}{stock.industry ? ` · ${stock.industry}` : ""}</p><Relations rows={stock.relations} /></article>)}</div>{!r.universe.symbols.length && <p className={s.sectionEmpty}>观察对象数据尚未就绪，请查看模型账本、信号与机会池的来源状态。</p>}</details>
      </section>
      <details className={s.sourceHealth} id="catalyst-sources"><summary>来源覆盖与数据说明<span>{coverage} / {r.sources.length} 个数据来源正常</span></summary><div className={s.healthList}>{[...r.sources, ...r.universe.health].map((source, i) => <div key={`${source.id}/${i}`}><div><strong>{source.label}</strong><span data-health={source.state}>{healthLabel[source.state]}</span></div><p>{source.detail}</p><small>检查 {timestamp(source.checkedAt)} · {source.count} 条 / 项</small></div>)}</div>{r.warnings.length > 0 && <ul className={s.warnings}>{r.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}<p className={s.footnote}>来源正常表示本次采集成功，不代表覆盖全部事件。无记录只能解释为当前来源未收录；AI 只总结已有事实，刷新页面不会触发采集或模型调用。</p></details>
    </>}
  </div>;
}
