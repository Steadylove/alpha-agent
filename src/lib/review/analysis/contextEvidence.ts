import { parseContextReport } from "@/lib/context/normalize";
import type { ContextReport } from "@/lib/context/types";
import type { AnalysisEvidence, AnalysisFact } from "./types";

const NOTE = "辅助观察，不参与评分或交易。共现不证明因果；期权流是部分市场样本，权利金不是净流入，不能推断机构身份或聪明钱。";

/** Raw, date-keyed observations only. Neither Context nor Catalyst AI prose is an input. */
export function appendContextEvidence(evidence: AnalysisEvidence, raw: unknown, now: Date): AnalysisEvidence {
  let report: ContextReport | null = null;
  try {
    const candidate = parseContextReport(raw, now);
    if (candidate.asOf === evidence.date && Date.parse(candidate.generatedAt) <= now.getTime() && Date.parse(candidate.cutoff) <= now.getTime()) report = candidate;
  } catch { /* Missing or invalid archives are represented by an explicit fact below. */ }
  const facts: AnalysisFact[] = [];
  const add = (id: string, label: string, value: AnalysisFact["value"], asOf: string | null = null,
    status: AnalysisFact["status"] = "current", note = NOTE, groups = ["context-sample"]) => {
    // Discord/Python archives can carry microseconds; keep original values in the record itself.
    const observedAt = asOf && /(?:Z|[+-]\d{2}:\d{2})$/.test(asOf) && Number.isFinite(Date.parse(asOf)) ? new Date(asOf).toISOString() : asOf;
    facts.push({ id: `context.${id}`, section: "context", label, value, unit: "说明", asOf: observedAt,
      basis: "auxiliary-saved-observation", status, source: `Context/${evidence.date}`, groups, note });
  };
  add("availability", "Event / Flow 辅助证据可用性", report ? "同日期 Context 原始记录可用，覆盖仍不完整" : "同日期 Context 不可用，无法判断事件与期权流共现关系", report?.asOf ?? null, report ? "current" : "missing");
  if (report) {
    const afterReview = Date.parse(report.cutoff) > Date.parse(evidence.sourceBuiltAt);
    add("cutoff", "辅助证据截止时间", report.cutoff, report.cutoff, "current",
      `原复盘生成于 ${evidence.sourceBuiltAt}。${afterReview ? "这是较晚的补充观察，不能回写为原复盘或入场时已知，也不能用后续事件解释当日状态成因。" : "仅在各条记录的实际可见时间内解释。"}`);
    for (const [key, coverage] of Object.entries(report.coverage)) {
      add(`coverage.${key}`, `${key === "events" ? "事件" : key === "flow" ? "期权流" : "信号"}来源覆盖`,
        `${coverage.state}：${coverage.detail}`, coverage.checkedAt,
        coverage.state === "unavailable" ? "missing" : "current", "采集成功不证明全市场或整个历史窗口完整覆盖；未收录不等于没有。");
    }
    // Keep the same bounded priority selection as the public Context. No post-hoc return ranking.
    for (const row of report.highlights.slice(0, 3)) {
      const symbol = encodeURIComponent(row.symbol).replaceAll("%", "_");
      add(`${symbol}.scope`, `${row.symbol} 观察状态`, `${row.stateLabel}；${row.warnings.join("；")}`.slice(0, 1800), report.asOf);
      const events = row.events.slice(0, 3), flows = row.flows.slice(0, 3);
      for (const [i, event] of events.entries()) {
        add(`${symbol}.event.${i}`, `${row.symbol} 已报道事件`, JSON.stringify({ ...event, title: event.title.slice(0, 800), sourceUrl: event.sourceUrl.slice(0, 700) }), event.publishedAt ?? event.eventDate, "current",
          `${NOTE} eventDate 是事件日期；firstSeenAt 与 updatedAt 分别为首次记录和当前版本可见时间。后续日期事件只能标为后续补充，不能写成复盘当日事件。`, ["context-events"]);
      }
      for (const [i, flow] of flows.entries()) {
        add(`${symbol}.flow.${i}`, `${row.symbol} 已收录异常期权流`, JSON.stringify({ ...flow, sourceUrl: flow.sourceUrl?.slice(0, 700) ?? null, flags: flow.flags.slice(0, 3) }), flow.postedAt, "current",
          `${NOTE} postedAt 是来源消息/转发时间，不是实际成交时间。首次记录或版本时间未知时，不能声称提前或当日捕捉。`, ["context-flow"]);
      }
      const pairs = row.associations.filter(pair => events.some(event => event.id === pair.eventId) && flows.some(flow => flow.id === pair.flowId)).slice(0, 3);
      for (const [i, pair] of pairs.entries()) add(`${symbol}.association.${i}`, `${row.symbol} 标的与时间共现`, JSON.stringify(pair), report.asOf, "current",
        "short 是前后一个实际交易日，research 是前后三个交易日；只有共现关系，不能归因为事件导致资金行为。", ["context-events", "context-flow"]);
      for (const [i, signal] of row.trend.signals.slice(0, 3).entries()) add(`${symbol}.signal.${i}`, `${row.symbol} ${signal.tf.toUpperCase()} 已捕捉信号`, JSON.stringify({ ...signal, eventLinks: signal.eventLinks.slice(0, 3), flowLinks: signal.flowLinks.slice(0, 3) }), signal.signalTime, "current",
        "系统信号不等于成交。known-at-signal / observed-after-signal / unknown 分别为当时已知、之后记录、未知；不得把之后记录的信息写成入场依据。", ["signal-quality", "daily-price"]);
      for (const [i, holding] of row.trend.holdings.slice(0, 2).entries()) add(`${symbol}.holding.${i}`, `${row.symbol} ${holding.tf.toUpperCase()} 模型持仓快照`, JSON.stringify(holding), holding.asOf, "current",
        "当前模型持仓不代表投资者账户，也不证明事件发生时已经持有。asOf 是账本日期，observedAt 是读取时间。", ["account-ledger"]);
      if (row.trend.rps) add(`${symbol}.rps`, `${row.symbol} 已有日线 RPS`, JSON.stringify(row.trend.rps), row.trend.rps.asOf, "current",
        "只读既有排名与口径；不是实时排名，不另行定义高 RPS 交易门槛。", ["daily-price", "sector-rps"]);
    }
    add("selection", "辅助观察选取范围", `最多展示 3 个优先标的；本次 ${report.highlights.length} 个，不代表全部事件、持仓或期权流。`, report.asOf);
  }
  return { ...evidence, facts: [...evidence.facts, ...facts], coverage: [...evidence.coverage, {
    section: "context", status: report ? "partial" : "unavailable",
    issues: [report ? "仅使用同日期留档的优先观察子集；来源与时间覆盖不完整，不能推出没有其他事件或资金行为。" : "无有效同日期 Context；未使用其他日期或最新快照替代。"],
  }] };
}
