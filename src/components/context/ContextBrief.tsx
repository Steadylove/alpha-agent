import type { ContextReport } from "@/lib/context/types";
import type { JournalSignal } from "@/lib/review/types";
import { contextBriefOutcome, contextBriefText, contextBriefTimeline, contextKnowledge, selectContextBrief } from "@/lib/context/brief";
import { Disclosure } from "@/components/Disclosure";
import { contextHref, contextMoney, contextNumber, contextSourceUrl, contextTime } from "./format";
import s from "./context.module.css";

const kinds = { "event-flow-signal": "事件 × 大单 × 信号", "event-signal": "事件 × 信号", "event-flow": "事件 × 大单" };
const knowledge = { "known-at-signal": "信号前已知", "observed-after-signal": "信号后才知该版本", unknown: "信号时是否已知待确认" };

/** Re-select saved evidence only. Rendering never collects data or invokes a model. */
export function ContextBrief({ report, journal = [] }: { report: ContextReport; journal?: JournalSignal[] }) {
  const items = selectContextBrief(report);
  return <section id="catalyst-today" className={s.brief} aria-labelledby="context-today-title">
    <header className={s.briefHeader}>
      <div><p className={s.eyebrow}>EVENT × FLOW × TREND</p><h2 id="context-today-title">Context Today <span>值得跟踪的关联</span></h2></div>
      <span className={s.coverageLabel}>{items.length ? `${items.length} 条关联观察 · ` : ""}部分市场样本</span>
    </header>
    <p className={s.capture}>{report.asOf} 留档 · 信息截至 {contextTime(report.cutoff)} · 生成于 {contextTime(report.generatedAt)}</p>
    {items.length ? <ol className={s.briefList}>{items.map(item => {
      const { observation, event, flow, signal } = item;
      const copy = contextBriefText(item);
      const source = contextSourceUrl(event.sourceUrl);
      const outcome = contextBriefOutcome(item, journal, report.asOf);
      return <li key={observation.symbol}>
        <div className={s.briefItemHeader}>
          <a href={contextHref(observation.symbol, report.asOf)} className={s.briefSymbol}>{observation.symbol}<span>查看留档 ↗</span></a>
          <span className={s.briefBadge}>{kinds[item.kind]}</span>
        </div>
        <div className={s.briefContent}>
          <div className={s.briefEvidence}>
            <h3>{copy.text}</h3>
            {flow && <p className={s.briefFlow}>OPTIONS FLOW · {flow.side === "buyer" ? "来源买入" : flow.side === "seller" ? "来源卖出" : "方向未确认"} {flow.right === "call" ? "Call" : "Put"}
              {flow.premium !== null ? ` · 权利金 ${contextMoney(flow.premium)}` : " · 金额未确认"}</p>}
            <p className={s.briefMeta}>
              {observation.trend.rps && <span>日线 RPS {contextNumber(observation.trend.rps.value)}</span>}
              {observation.trend.holdings.map(holding => <span key={holding.tf}>{holding.tf.toUpperCase()} 模型持仓快照</span>)}
              {!flow && <span>本次期权流样本未匹配</span>}
            </p>
          </div>
          <ol className={s.briefTimeline} aria-label={`${observation.symbol} 证据时间线`}>
            {contextBriefTimeline(item).map(moment => <li key={moment.key}>
              <span className={s.momentLabel}>{moment.label}</span>
              <time dateTime={moment.at ?? moment.date}>{contextTime(moment.at ?? moment.date)}</time>
              {moment.knowledge && <span className={moment.knowledge === "known-at-signal" ? s.known : s.uncertain}>{knowledge[moment.knowledge]}</span>}
              <small>{moment.note}{!moment.at ? "；不能判断日内先后" : ""}</small>
            </li>)}
          </ol>
        </div>
        <Disclosure className={s.briefDisclosure} title="原始报道与事后验证">
          <p className={s.originalTitle}>{event.title}</p>
          {source && <a className={s.link} href={source} target="_blank" rel="noopener noreferrer">原始来源 ↗</a>}
          <p>系统首次发现 {contextTime(event.firstSeenAt)} · 当前版本记录 {contextTime(event.updatedAt)}</p>
          {signal && <p>系统信号捕获于 {contextTime(signal.capturedAt)}。{contextKnowledge(item, "event") !== "known-at-signal" ? "该事件不能作为信号发生前已知的筛选依据。" : "事件版本在信号前已记录；时间先后不代表因果。"}</p>}
          {signal?.event === "buy" ? outcome ? <>
            <dl className={s.briefOutcomes}>{(["t1", "t3", "t5"] as const).map((key, index) => <div key={key}><dt>T+{[1, 3, 5][index]}</dt><dd>{outcome[key].status === "ready" && outcome[key].value !== null ? contextNumber(outcome[key].value, "%", true) : outcome[key].status === "pending" ? "待观察" : "行情缺失"}</dd><small>{outcome[key].date}</small></div>)}</dl>
            <p>截至 {report.asOf}，沿用 Signal Journal 的信号价至后续收盘收益，未计交易成本；单例不证明筛选有效。</p>
          </> : <p>尚未匹配到同一真实买点的收益跟踪记录。</p> : <p>{signal ? "卖点未套用多头买点收益口径。" : "未关联系统买点，暂无信号收益跟踪。"}</p>}
        </Disclosure>
      </li>;
    })}</ol> : <p className={s.briefEmpty}>今日暂无达到展示条件的关联观察。新闻与原始记录仍保留在事件观察和个股详情中。</p>}
    <Disclosure className={s.briefDisclosure} title="筛选规则与数据覆盖">
      <p>首页仅展示较重要的公司事件与同日系统信号，或前后一个交易日内的异常流关联；汇总类新闻、仅有持仓或 RPS 的条目不占首页卡片。最多三只，优先多类证据及信号前已知记录。中文概述基于事件分类与时间关联，新闻原文保留供核对。</p>
      <p>Partial Market Sample · 未收录不代表没有成交。共现不是因果；当前模型持仓不能倒推事件发生时的持仓。</p>
      {Object.entries(report.coverage).map(([key, row]) => <p key={key}>{key === "events" ? "事件" : key === "flow" ? "期权流" : "信号"}：{row.detail} · 检查于 {contextTime(row.checkedAt)}</p>)}
      {report.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
      <a className={s.link} href="/catalyst">打开事件观察（最新） ↗</a>
    </Disclosure>
  </section>;
}
