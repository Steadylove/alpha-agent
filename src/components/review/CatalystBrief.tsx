import type { CatalystBriefItem, CatalystReviewDigest, CatalystReviewView } from "@/lib/catalyst/reviewDigest";
import styles from "./catalystBrief.module.css";

const missing: CatalystReviewView = { status: "missing", digest: null };
const relationLabels = { Portfolio: "模型持仓", Signal: "系统信号", Sector: "板块", Market: "市场" };
const kindLabels = { company: "公司事件", sector: "板块事件", market: "市场事件", upcoming: "未来日程" };

function sourceUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname)) return null;
    return url.toString();
  } catch { return null; }
}
function timestamp(stamp: string): string {
  if (!Number.isFinite(Date.parse(stamp))) return "时间待确认";
  return `${new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(stamp))} ET`;
}
function delta(value: number | null, unit: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(2));
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}${unit}`;
}
function Metric({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  const rounded = value == null || !Number.isFinite(value) ? 0 : Number(value.toFixed(2));
  return <div><dt>{label}</dt><dd className={rounded > 0 ? styles.up : rounded < 0 ? styles.down : styles.neutral}>{delta(value, unit)}</dd></div>;
}
function ItemTitle({ item }: { item: CatalystBriefItem }) {
  const url = sourceUrl(item.sourceUrl);
  const body = <><b>{item.subject}</b><span>{item.title}</span></>;
  return url ? <a className={styles.itemTitle} href={url} target="_blank" rel="noopener noreferrer" aria-label={`${item.subject}：${item.title}，查看来源（新窗口）`}>{body}</a>
    : <div className={styles.itemTitle}>{body}<small>来源链接不可用</small></div>;
}
function Tag({ item }: { item: CatalystBriefItem }) {
  return <span className={styles.tag} title={relationLabels[item.relation]}>{item.relation}<span className={styles.srOnly}> · {relationLabels[item.relation]}</span></span>;
}
function Capture({ digest }: { digest: CatalystReviewDigest }) {
  return <p className={styles.capture}>{digest.reviewDate} 复盘补充 · 采于 <time dateTime={digest.capturedAt}>{timestamp(digest.capturedAt)}</time>（非原发布时间）</p>;
}
function Coverage({ digest }: { digest: CatalystReviewDigest }) {
  return <span className={digest.status === "ready" ? styles.coverage : styles.warning}>{digest.status === "ready" ? "已覆盖来源" : digest.status === "partial" ? "部分覆盖" : "覆盖不可用"}</span>;
}
function Empty({ catalyst, upcoming = false }: { catalyst: CatalystReviewView; upcoming?: boolean }) {
  if (catalyst.status === "missing" || catalyst.status === "ready" && !catalyst.digest) return <p className={styles.empty}>该交易日尚无事件补充留档，不能据此判断没有催化剂。</p>;
  if (catalyst.status === "unavailable" || catalyst.digest?.status === "unavailable") return <p className={styles.empty}>事件补充暂不可用，现有复盘仍可查看；来源缺失不代表没有事件。</p>;
  if (catalyst.digest?.status === "partial") return <p className={styles.empty}>已覆盖来源暂未筛出{upcoming ? "未来 72 小时的相关日程" : "相关重点"}；仍有来源缺失，不能视为没有事件。</p>;
  return <div className={styles.empty}><strong>No Material Catalyst</strong><span>{upcoming ? "在本次已覆盖的日历与关联对象中，未发现未来 72 小时达到筛选条件的重要日程。" : "在本次已覆盖的来源与关联对象中，未发现达到筛选条件的重要事件。"}</span></div>;
}

/** Saved post-review supplement only. No fetching, scoring or model calls happen in this component. */
export function CatalystToday({ catalyst = missing }: { catalyst?: CatalystReviewView }) {
  const digest = catalyst.status === "ready" ? catalyst.digest : null;
  const items = digest && digest.status !== "unavailable" ? digest.today.slice(0, 3) : [];
  return <section id="catalyst-today" className={styles.today} aria-labelledby="catalyst-today-title">
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>EVENT CONTEXT</p><h2 id="catalyst-today-title">Catalyst Today <span>事件线索</span></h2></div>
      <div className={styles.actions}>{digest && <Coverage digest={digest} />}<a className={styles.monitorLink} href="/catalyst">Catalyst Monitor <span aria-hidden>↗</span></a></div>
    </header>
    {digest && <Capture digest={digest} />}
    {items.length ? <ol className={styles.todayItems}>{items.map(item => <li key={item.id}>
      <div className={styles.itemMeta}><span>{kindLabels[item.kind]}</span><Tag item={item} /></div>
      <ItemTitle item={item} />
      <p className={styles.eventTime}>{item.timeLabel}</p>
      {item.kind !== "upcoming" && <dl className={styles.metrics}>
        <Metric label="Price · T0" value={item.priceChange} unit="%" />
        {item.kind !== "market" && <Metric label={item.kind === "sector" ? "板块 RPS Δ" : "RPS Δ"} value={item.kind === "sector" ? item.sectorRpsChange : item.rpsChange} unit=" pt" />}
      </dl>}
    </li>)}</ol> : <Empty catalyst={catalyst} />}
    {digest && items.some(item => item.kind !== "upcoming") && <p className={styles.basis}>Price 为日线变化，非事件即时影响。</p>}
    {digest && <details className={styles.details}><summary>口径与覆盖{digest.warnings.length > 0 ? ` · ${digest.warnings.length} 项提示` : ""}</summary>
      <p>Price：该交易日 T0 收盘相对前收盘变化，包含公告前波动，不代表即时影响或因果。RPS Δ：同口径强度变化；“—”表示缺少可比数据。</p>
      <p>补充资料采集晚于原复盘，不代表原复盘发布时已知。</p>
      {!!digest.warnings.length && <ul>{digest.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>}
    </details>}
  </section>;
}

/** Only concise saved schedules belong here; original Tomorrow Map priorities remain separate. */
export function CatalystTomorrow({ catalyst = missing }: { catalyst?: CatalystReviewView }) {
  const digest = catalyst.status === "ready" ? catalyst.digest : null;
  const items = digest && digest.status !== "unavailable" ? digest.upcoming.filter(item => item.kind === "upcoming").slice(0, 3) : [];
  return <section className={styles.tomorrow} aria-labelledby="catalyst-tomorrow-title">
    <header className={styles.header}>
      <div><h3 id="catalyst-tomorrow-title">Tomorrow Events <span>未来 72 小时</span></h3></div>
      <div className={styles.actions}>{digest && <Coverage digest={digest} />}<a className={styles.monitorLink} href="/catalyst">查看事件日历 <span aria-hidden>↗</span></a></div>
    </header>
    {digest && <Capture digest={digest} />}
    {items.length ? <ol className={styles.schedule}>{items.map(item => <li key={item.id}>
      <ItemTitle item={item} />
      <div className={styles.scheduleMeta}><span>{item.timeLabel}</span><Tag item={item} /></div>
    </li>)}</ol> : <Empty catalyst={catalyst} upcoming />}
    {digest && <p className={styles.archiveNote}>按本次采集时刻计算；最新日程见事件观察。</p>}
  </section>;
}
