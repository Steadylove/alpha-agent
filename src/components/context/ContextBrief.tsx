import type { ContextObservation, ContextReport } from "@/lib/context/types";
import { contextHref, contextMoney, contextNumber, contextTime } from "./format";
import s from "./context.module.css";
import { ContextCitations } from "./ContextLinks";

function FlowRead({ observation }: { observation: ContextObservation }) {
  const known = observation.flows.filter(flow => flow.premium !== null);
  return <>
    <p>{observation.flows.length
      ? `${observation.flows.length} 条已收录记录${known.length ? ` · 已知权利金 ${contextMoney(known.reduce((sum, flow) => sum + flow.premium!, 0))}` : " · 金额待确认"}`
      : "本次归档未收录相关异常流。"}</p>
    <small>Partial Market Sample · 不代表完整市场成交</small>
  </>;
}

/** Frozen supplement: rendering never collects events, invokes a model, or changes signals. */
export function ContextBrief({ report }: { report: ContextReport }) {
  return <section id="catalyst-today" className={s.brief} aria-labelledby="context-today-title">
    <header className={s.briefHeader}>
      <div><p className={s.eyebrow}>EVENT × FLOW × TREND</p><h2 id="context-today-title">Context Today <span>把线索放在一起看</span></h2></div>
      <span className={s.coverageLabel}>Partial Market Sample · 部分市场样本</span>
    </header>
    <p className={s.capture}>{report.asOf} 留档 · 信息截至 {contextTime(report.cutoff)} · 生成于 {contextTime(report.generatedAt)}</p>
    {report.highlights.length > 0 ? <ol className={s.briefList}>{report.highlights.slice(0, 3).map(observation => <li key={observation.symbol}>
      <div className={s.itemMeta}><a className={s.link} href={contextHref(observation.symbol, report.asOf)}><strong>{observation.symbol}</strong> · 查看完整 Context ↗</a><span>{observation.stateLabel}</span></div>
      <div className={s.briefTracks}>
        <div><h3>EVENT · 现实事件</h3><p>{observation.events[0]?.title ?? "已覆盖来源未收录相关事件，不能据此认定没有事件。"}</p>{observation.events.length > 1 && <small>另有 {observation.events.length - 1} 条已收录事件</small>}</div>
        <div><h3>OPTIONS FLOW · 异常流</h3><FlowRead observation={observation} /></div>
        <div><h3>TREND · 系统观察</h3><p>{observation.trend.label}</p><small>{observation.trend.rps ? `RPS ${contextNumber(observation.trend.rps.value)} · ${observation.trend.rps.asOf}` : "RPS 同日数据待确认"}{observation.trend.holdings.length ? " · 关联当前模型持仓快照" : ""}</small></div>
      </div>
      <p className={s.footnote}>{observation.summary}</p>
    </li>)}</ol> : <p className={s.empty}>本次已覆盖资料中，暂无达到展示条件的关联观察；来源缺失不等于没有事件或异常成交。</p>}
    <details className={s.details}><summary>覆盖范围与解读口径</summary>
      {report.summaryStatus === "ready" && report.summary && <><p>独立关联解读 · {report.summary.model} · {contextTime(report.summary.generatedAt)}</p>{report.summary.sentences.map((sentence, i) => <p key={i}>{sentence.text}<ContextCitations report={report} evidenceIds={sentence.evidenceIds} /></p>)}</>}
      <p>事件、来源报道与系统趋势按时间并列观察。共现不是因果，信号不是已执行交易，模型持仓不代表事件发生时的持仓。</p>
      {Object.entries(report.coverage).map(([key, row]) => <p key={key}>{key === "events" ? "事件" : key === "flow" ? "期权流" : "信号"}：{row.detail} · 检查于 {contextTime(row.checkedAt)}</p>)}
      {report.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
    </details>
  </section>;
}
