import type {
  AnalysisClaim,
  AnalysisFact,
  AnalysisOutput,
  AnalysisSection,
  AnalysisView,
} from "@/lib/review/analysis/types";
import styles from "./analyst.module.css";

const SECTION_LABELS: Record<AnalysisSection, string> = {
  market: "市场状态",
  options: "期权结构",
  sectors: "板块强度",
  signals: "买点复盘",
  accounts: "模型账户",
  journal: "信号验证",
  tomorrow: "明日关注",
};
const FACT_STATUS: Record<AnalysisFact["status"], string> = {
  current: "有效",
  delayed: "滞后数据",
  stale: "已过期",
  missing: "缺失",
  unknown: "待确认",
};
const COVERAGE_LABELS = {
  available: "可用",
  partial: "部分可用",
  unavailable: "不可用",
};
const GROUPS: [Exclude<keyof AnalysisOutput, "lead">, string][] = [
  ["changes", "值得留意的变化"],
  ["divergences", "尚未一致的信号"],
  ["confirmations", "当前一致的观察"],
  ["context", "放回系统中理解"],
  ["focus", "下一交易日，继续观察"],
  ["limitations", "这份解读的边界"],
];

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${new Intl.DateTimeFormat("zh-CN", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(date)} ET`
    : "时间未留档";
}

function Fact({ fact }: { fact: AnalysisFact }) {
  const value = fact.value === null ? "—" : String(fact.value);
  return (
    <li>
      <div className={styles.factTitle}>
        <a href={`#${fact.section}`}>{SECTION_LABELS[fact.section]} ↗</a>
        <span>{FACT_STATUS[fact.status]}</span>
      </div>
      <p>
        <b>{fact.label}</b>：{value}{fact.value !== null && fact.unit ? ` ${fact.unit}` : ""}
      </p>
      <small>
        截至 {fact.asOf ?? "日期未留档"} · {fact.source}
        {fact.basis ? ` · ${fact.basis}` : ""}
      </small>
      {fact.note && <p className={styles.factNote}>{fact.note}</p>}
    </li>
  );
}

function Claim({ claim, facts, lead = false }: {
  claim: AnalysisClaim;
  facts: Map<string, AnalysisFact>;
  lead?: boolean;
}) {
  const references = [...new Set(claim.factIds)]
    .map((id) => facts.get(id))
    .filter((fact): fact is AnalysisFact => fact !== undefined);
  return (
    <div className={lead ? styles.lead : styles.claim}>
      <p>{claim.text}</p>
      {references.length > 0 && (
        <details className={styles.evidence}>
          <summary>查看依据 · {references.length} 项</summary>
          <ul>{references.map((fact) => <Fact key={fact.id} fact={fact} />)}</ul>
        </details>
      )}
    </div>
  );
}

export function AnalystNote({ analysis }: { analysis: AnalysisView }) {
  const { report, status } = analysis;
  if (!report || status === "missing" || status === "unavailable") {
    return (
      <div className={styles.empty} role="status">
        <p>{status === "unavailable"
          ? "独立分析暂时无法读取，现有复盘仍可正常查看。"
          : "等待该交易日复盘生成后的自动分析。"}</p>
        <span>此处展示已保存的 DeepSeek 解读，刷新页面不会重新调用模型。</span>
      </div>
    );
  }

  const { evidence, output } = report;
  const facts = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const limitedCoverage = evidence.coverage.filter((row) => row.status !== "available");
  const coverageLabel = evidence.coverage.every((row) => row.status === "unavailable")
    ? "数据不可用"
    : limitedCoverage.length ? "部分数据可用" : "数据可用";
  return (
    <article className={styles.root} aria-label="DeepSeek 独立复盘分析">
      <div className={styles.dateline}>
        <span>美东交易日 {report.date} · {status === "stale" ? "旧版留档" : "已保存"}</span>
        <span>DeepSeek · {report.model} · 生成于 {timestamp(report.generatedAt)}</span>
      </div>
      {status === "stale" && (
        <p className={styles.notice} role="status">
          复盘数据已在这份分析生成后更新。以下保留原解读，当前数据请以前面的复盘模块为准。
        </p>
      )}
      <dl className={styles.states}>
        <div><dt>原始市场状态</dt><dd>{evidence.states.market}</dd></div>
        <div><dt>宏观环境</dt><dd>{evidence.states.macro}</dd></div>
        <div><dt>输入完整性</dt><dd>{coverageLabel}</dd></div>
      </dl>
      <Claim claim={output.lead} facts={facts} lead />
      <div className={styles.groups}>
        {GROUPS.filter(([key]) => output[key].length > 0).map(([key, title]) => (
          <section key={key} className={styles.group}>
            <h3>{title}</h3>
            <div>
              {output[key].map((claim, index) => <Claim key={index} claim={claim} facts={facts} />)}
            </div>
          </section>
        ))}
      </div>
      <details className={styles.sourceDetails}>
        <summary>数据完整性与生成记录{limitedCoverage.length ? ` · ${limitedCoverage.length} 个模块有缺项` : ""}</summary>
        <dl className={styles.record}>
          <div><dt>分析生成</dt><dd>{timestamp(report.generatedAt)}</dd></div>
          <div><dt>采用的复盘版本</dt><dd>{timestamp(report.sourceBuiltAt)}</dd></div>
          {evidence.states.legacy !== evidence.states.market && (
            <div><dt>原始兼容状态</dt><dd>{evidence.states.legacy}（与市场状态字段分别保留）</dd></div>
          )}
        </dl>
        <ul className={styles.coverage}>
          {evidence.coverage.map((row) => (
            <li key={row.section}>
              <a href={`#${row.section}`}>{SECTION_LABELS[row.section]} ↗</a>
              <span>{COVERAGE_LABELS[row.status]}</span>
              {row.issues.length > 0 && <p>{row.issues.join("；")}</p>}
            </li>
          ))}
        </ul>
      </details>
      <p className={styles.footnote}>
        本文依据留档数据生成，生成时间可能晚于交易日；历史解读不代表当时已发布的判断。
        AI 解读用于辅助理解，原始状态与交易规则仍以系统为准，不构成交易指令。
      </p>
    </article>
  );
}
