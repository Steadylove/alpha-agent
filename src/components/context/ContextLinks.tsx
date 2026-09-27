import type { ContextReport } from "@/lib/context/types";
import { contextEvidenceId, contextHref } from "./format";
import s from "./context.module.css";

export function FlowContextLink({ symbol, date, report, brief = false }: {
  symbol: string; date: string; report?: ContextReport | null; brief?: boolean;
}) {
  const observation = report?.asOf === date ? report.observations.find(row => row.symbol === symbol) : undefined;
  return <div>
    <a className={s.link} href={contextHref(symbol, date)}>Event Context ↗</a>
    {brief && <p className={s.footnote}>{observation
      ? `${observation.stateLabel} · ${observation.events[0]?.title ?? "已覆盖来源未收录相关事件"}`
      : "该日关联留档待补充；不使用其他日期代替。"}</p>}
    {!brief && <small className={s.relation}>{observation?.stateLabel ?? "该日留档待补充"}</small>}
  </div>;
}

export function ContextCitations({ report, evidenceIds }: { report: ContextReport; evidenceIds: string[] }) {
  return <span className={s.citations}>{evidenceIds.map((id, index) => {
    const observation = report.observations.find(row => row.timeline.some(item => item.id === id));
    const item = observation?.timeline.find(row => row.id === id);
    if (!observation || !item) return null;
    const label = item.track === "event" ? "Event" : item.track === "flow" ? "Flow" : "Trend";
    return <a key={id} className={s.link} href={`${contextHref(observation.symbol, report.asOf)}#${encodeURIComponent(contextEvidenceId(id))}`} aria-label={`查看依据 ${index + 1}：${observation.symbol} ${item.title}`}>{label} {index + 1} ↗</a>;
  })}</span>;
}
