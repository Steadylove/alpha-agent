import type { ReactNode } from "react";
import type { ContextFlowEvidence, ContextReport, ContextSymbol } from "@/lib/context/types";
import { PageHeading } from "@/components/PageHeading";
import { contextEvidenceId, contextMoney, contextNumber, contextSourceUrl, contextTime } from "./format";
import { ContextCitations } from "./ContextLinks";
import s from "./context.module.css";

export type SymbolContextData = { report: ContextReport; observation: ContextSymbol };
const state = { ok: "已覆盖来源", partial: "部分覆盖", unavailable: "来源不可用" };
const knowledge = { "known-at-signal": "信号时已知该版本", "observed-after-signal": "信号之后才知该版本", unknown: "信号时是否已知待确认" };

function Source({ url, children }: { url: string | null; children: ReactNode }) {
  const href = contextSourceUrl(url);
  return href ? <a className={s.link} href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a> : <span className={s.footnote}>来源链接不可用</span>;
}

function flowLabel(flow: ContextFlowEvidence) {
  const right = flow.right === "call" ? "Call" : "Put";
  return flow.side === "buyer" ? `Buy ${right}` : flow.side === "seller" ? `Sell ${right}` : `${right} · 买卖方未核验`;
}

export function SymbolContext({ symbol, date, context }: {
  symbol: string; date?: string; context: SymbolContextData | null;
}) {
  const valid = context && (!date || context.report.asOf === date) && context.observation.symbol === symbol ? context : null;
  const backDate = valid?.report.asOf ?? date;
  const dateQuery = backDate ? `?date=${encodeURIComponent(backDate)}` : "";
  if (!valid) return <div className={s.root}>
    <PageHeading eyebrow="CONTEXT LAYER" title={symbol} english="Event × Flow × Trend" description="把现实事件、异常流与系统观察放回各自的时间。" />
    <p className={s.notice} role="status">{date ? `${date} 尚无该标的可读取的 Context 留档。` : "尚无该标的可读取的 Context 留档。"}未用其他日期代替，也不能据此判断没有事件或异常流。</p>
    <p className={s.footnote}>页面只读取已保存结果；刷新页面不会触发采集、模型分析或交易。</p>
    <nav className={s.nav} aria-label="Context 返回导航"><a href={`/${dateQuery}`}>返回每日复盘 ↗</a><a href={`/flow${dateQuery}`}>查看同日期权流 ↗</a></nav>
  </div>;
  const { report, observation: o } = valid;
  const summary = report.summaryStatus === "ready" ? report.summary?.sentences.filter(sentence => sentence.evidenceIds.every(id => o.timeline.some(item => item.id === id))) : [];
  return <div className={s.root}>
    <PageHeading eyebrow="CONTEXT LAYER" title={symbol} english="Event × Flow × Trend" description="现实发生了什么、来源报道了什么、系统观察到什么。" />
    <div className={s.metadata}><span>{report.asOf} · 已保存的观察</span><span>信息截至 {contextTime(report.cutoff)}</span><span>生成 {contextTime(report.generatedAt)}</span></div>
    <div className={s.summary}><p>{o.stateLabel}</p><p>{o.summary}</p></div>
    {summary && summary.length > 0 && <details className={s.details}><summary>独立关联解读 · {report.summary?.model}</summary>{summary.map((sentence, i) => <p key={i}>{sentence.text}<ContextCitations report={report} evidenceIds={sentence.evidenceIds} /></p>)}<p>生成于 {contextTime(report.summary?.generatedAt)} · 依据为下方对应事件、异常流与趋势留档。</p></details>}
    <p className={s.footnote}>Partial Market Sample · 非完整市场样本，仅用于辅助观察。事件与异常流共现不表示因果，未收录也不表示不存在。</p>
    <nav className={s.nav} aria-label="Context 三条观察轨道"><a href="#context-events">01 / Event</a><a href="#context-flow">02 / Options Flow</a><a href="#context-trend">03 / Trend</a><a href={`/${dateQuery}#catalyst-today`}>返回当日复盘 ↗</a></nav>

    <section id="context-events" className={s.section}>
      <header className={s.sectionHead}><div><p className={s.eyebrow}>01 / EVENT</p><h2>现实事件</h2><p>发布时间、系统首次发现与本次收录分别保留。</p></div><span className={s.coverageLabel}>{state[report.coverage.events.state]}</span></header>
      {o.events.length ? <ol className={s.eventList}>{o.events.map(event => <li key={event.id} id={contextEvidenceId(`event:${event.id}`)}>
        <div className={s.itemMeta}><span>{event.type} · {event.eventDate}</span><span>归档事件第 {event.revision} 版</span></div>
        <h3>{event.title}</h3>
        <div className={s.sourceRow}><span>来源发布 {contextTime(event.publishedAt)}</span><Source url={event.sourceUrl}>原始来源</Source></div>
        <details className={s.details}><summary>时间与首次发现记录</summary><dl className={s.record}>
          <dt>事件日期</dt><dd>{event.eventDate}{event.timePrecision !== "minute" ? " · 未提供可核验的分钟时间" : ""}</dd>
          <dt>来源发布时间</dt><dd>{contextTime(event.publishedAt)}</dd>
          <dt>系统首次发现</dt><dd>{contextTime(event.firstSeenAt)}</dd>
          <dt>当前版本首次记录</dt><dd>{contextTime(event.updatedAt)}</dd>
          <dt>关联交易日</dt><dd>{event.anchorDate ?? "交易日待确认"} · 用于关联窗口，与价格反应 T0 分开</dd>
        </dl><p>首次发现时间是系统实际记录时间；后续补录不能视为事件当时已知。</p></details>
      </li>)}</ol> : <p className={s.empty}>本次归档未收录相关事件。{report.coverage.events.detail} 未收录不等于没有事件。</p>}
    </section>

    <section id="context-flow" className={s.section}>
      <header className={s.sectionHead}><div><p className={s.eyebrow}>02 / OPTIONS FLOW</p><h2>来源中的异常期权流</h2><p>Partial Market Sample · 方向是来源成交结构标签，不是资金真实意图。</p></div><span className={s.coverageLabel}>{state[report.coverage.flow.state]}</span></header>
      {o.flows.length ? <ol className={s.flowList}>{o.flows.map(flow => {
        const links = o.associations.filter(row => row.flowId === flow.id);
        return <li key={flow.id} id={contextEvidenceId(`flow:${flow.id}`)}>
          <div className={s.itemMeta}><span>{flowLabel(flow)}</span><span>来源报道 {contextTime(flow.postedAt)}</span></div>
          <dl className={s.facts}><div><dt>行权价</dt><dd>{contextNumber(flow.strike, " USD")}</dd></div><div><dt>到期日</dt><dd>{flow.expiry ?? "未提供"}</dd></div><div><dt>可归属权利金</dt><dd>{contextMoney(flow.premium)}</dd></div></dl>
          <div className={s.sourceRow}><span>系统首次观察 {contextTime(flow.firstObservedAt)}</span><Source url={flow.sourceUrl}>原始报道</Source></div>
          {links.length > 0 && <p className={s.footnote}>同时间窗口内的事件：{links.map(link => `${o.events.find(event => event.id === link.eventId)?.title ?? "关联事件"}（相隔 ${link.sessionDistance} 个交易日）`).join("；")}。仅为时间关联。</p>}
          <details className={s.details}><summary>归档版本与核验情况</summary><dl className={s.record}>
            <dt>首次观察口径</dt><dd>{flow.provenanceStatus === "recorded" ? "已有来源追溯记录" : "旧记录，首次观察信息不完整"}</dd>
            <dt>当前版本首次记录</dt><dd>{contextTime(flow.updatedAt)}</dd>
            <dt>归档版本</dt><dd>{flow.revision ?? "未留档"}</dd>
            <dt>报道对应交易日</dt><dd>{flow.anchorDate ?? "待确认"}</dd>
          </dl>{flow.flags.map((flag, i) => <p key={i}>{flag}</p>)}</details>
        </li>;
      })}</ol> : <p className={s.empty}>本次归档未收录该标的的异常流。{report.coverage.flow.detail} 不能据此认定全市场没有相关成交。</p>}
      <p className={s.footnote}>Buy Call / Sell Put 等标签按来源记录展示，可能包含对冲或组合交易。这里不推断聪明资金、机构净买入或下一步涨跌。</p>
    </section>

    <section id="context-trend" className={s.section}>
      <header className={s.sectionHead}><div><p className={s.eyebrow}>03 / TREND</p><h2>系统留下的观察</h2><p>{o.trend.label}</p></div><span className={s.coverageLabel}>{state[report.coverage.signals.state]}</span></header>
      <dl className={s.facts}><div id={o.trend.rps ? contextEvidenceId(`rps:${symbol}:${o.trend.rps.asOf}`) : undefined}><dt>日线 RPS</dt><dd>{contextNumber(o.trend.rps?.value)}<small>{o.trend.rps ? `${o.trend.rps.asOf} · ${o.trend.rps.basis}` : "该日数据缺失；不采用其他日期排名"}</small></dd></div><div><dt>已归档系统信号</dt><dd>{o.trend.signals.length} 条<small>信号不等于已执行交易</small></dd></div></dl>
      {o.trend.signals.length ? <ul className={s.signalList}>{o.trend.signals.map(signal => <li key={signal.id} id={contextEvidenceId(`signal:${signal.id}`)}>
        <b>{signal.tf.toUpperCase()} · {signal.event === "buy" ? "买点" : "卖点"}</b><span>{contextTime(signal.signalTime)}</span><small>系统实收 {contextTime(signal.capturedAt)}</small>
        {signal.eventLinks.map(link => <small key={link.eventId}>{o.events.find(event => event.id === link.eventId)?.title ?? "关联事件"}：{knowledge[link.knowledge]}</small>)}
        {(signal.flowLinks ?? []).map(link => <small key={link.flowId}>关联异常流：{knowledge[link.knowledge]}</small>)}
      </li>)}</ul> : <p className={s.empty}>当前已覆盖归档未关联到系统信号，不代表系统历史上从未发出信号。</p>}
      <p className={s.footnote}>已知状态以信号时间核对来源发布、首次发现与版本时间；系统实收时间单独保留。时间先后不表示事件或异常流导致了信号。</p>
      {o.trend.holdings.length > 0 ? <div className={s.section}><h3>当前模型持仓快照</h3><ul className={s.signalList}>{o.trend.holdings.map((holding, i) => <li key={`${holding.tf}/${i}`} id={contextEvidenceId(`holding:${holding.tf}:${symbol}`)}><b>{holding.tf.toUpperCase()} 模型账户</b><span>快照日期 {holding.asOf}</span><small>观察 {contextTime(holding.observedAt)}</small></li>)}</ul><p className={s.footnote}>CURRENT MODEL · 此处为所选归档中保留的模型持仓快照，不是券商成交，也不能倒推事件发生时持仓。</p></div> : <p className={s.footnote}>本次未关联到当前模型持仓快照；不能推断曾经持有、已卖出或从未交易。</p>}
    </section>

    <section className={s.section} aria-label="Context 来源覆盖与记录边界"><h2>覆盖范围与记录边界</h2>
      <dl className={s.coverage}>{Object.entries(report.coverage).map(([key, coverage]) => <div key={key}><dt>{key === "events" ? "Event" : key === "flow" ? "Options Flow" : "Trend / Signals"} · {state[coverage.state]}</dt><dd>{coverage.detail}<br />检查 {contextTime(coverage.checkedAt)}{coverage.from || coverage.through ? ` · 已核验日期 ${coverage.from ?? "待确认"} 至 ${coverage.through ?? "待确认"}` : ""}</dd></div>)}</dl>
      <ul className={s.warnings}>{[...new Set([...report.warnings, ...o.warnings])].map((warning, i) => <li key={i}>{warning}</li>)}</ul>
      <p className={s.footnote}>每条记录使用本次归档中的时间与版本。页面只读保存结果，不改变买点评分、持仓、止损或止盈规则，不提供自动交易建议。</p>
    </section>
  </div>;
}
