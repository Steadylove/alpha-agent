"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { ResearchPage } from "@/lib/optionFlow/research/store";
import type { FlowProfile } from "@/lib/optionFlow/research/model";
import s from "./flow.module.css";

const money = (n: number | null) => n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;
const number = (n: number | null) => n == null ? "—" : n.toFixed(1);
const signed = (n: number | null, percent = false) => n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(2)}${percent ? "%" : ""}`;
const tone = (n: number | null) => n == null ? s.muted : n > 0 ? s.up : n < 0 ? s.down : "";
const timestamp = (raw: string) => Number.isFinite(Date.parse(raw)) ? `${new Intl.DateTimeFormat("zh-CN", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(raw))} ET` : "未知";
function Rps({ p }: { p: FlowProfile }) {
  return <span className={s.rps}><strong>{number(p.rps)}</strong><span><i style={{ width: `${p.rps ?? 0}%` }} /></span></span>;
}
function Heading({ n, title, sub }: { n: string; title: string; sub: string }) {
  return <div className={s.sectionHeading}><div><span className={s.eyebrow}>{n}</span><h2>{title}</h2></div><p>{sub}</p></div>;
}

export function FlowResearchBoard({ report: r, dates, outcomes, error }: ResearchPage) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("全部");
  const go = (day: string) => start(() => router.push(`/flow?date=${encodeURIComponent(day)}`));
  const index = dates.indexOf(r?.date ?? "");
  const rows = r?.profiles.filter(p => {
    if (!p.ticker.includes(search.trim().toUpperCase())) return false;
    if (filter === "全部") return true;
    return filter === "重复出现" ? p.persistence !== "首次观察" : p.strength === filter;
  }) ?? [];
  const groups = [...new Set(outcomes.map(o => o.strength))].map(strength => {
    const list = outcomes.filter(o => o.strength === strength && o.t5 != null);
    const excess = list.filter(o => o.excess5 != null);
    return { strength, count: list.length, avg: list.length ? list.reduce((sum, o) => sum + o.t5!, 0) / list.length : null,
      excess: excess.length ? excess.reduce((sum, o) => sum + o.excess5!, 0) / excess.length : null };
  });
  return <div className={s.root} aria-busy={pending}>
    <header className={s.hero}>
      <div><div className={s.eyebrow}>FLOW OBSERVATORY / MARKET COMPASS</div><h1>异常期权流 <em>研究室</em></h1><p>资金出现在哪里，强度是否跟上，是否持续发生。</p></div>
      <div className={s.dateControl}>
        <button aria-label="上一交易日" disabled={pending || index <= 0} onClick={() => go(dates[index - 1])}><ChevronLeft size={17} /></button>
        <select aria-label="研究日期" value={r?.date ?? ""} disabled={pending || !dates.length} onChange={e => go(e.target.value)}>
          {!r && <option value="">选择研究日期</option>}{[...dates].reverse().map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button aria-label="下一交易日" disabled={pending || index < 0 || index >= dates.length - 1} onClick={() => go(dates[index + 1])}><ChevronRight size={17} /></button>
      </div>
    </header>
    {error && <div role="alert" className={s.notice}>{error}</div>}
    {!r ? <div className={s.empty}>数据就绪后，这里会呈现真实记录、强度对照与跟踪结果。<button onClick={() => start(() => router.refresh())}>重新读取</button></div> : <>
      <div className={s.meta}><span className={s.dot} /> FL0WG0D 报道样本 <span>·</span> {r.origin === "archived" ? "已归档" : "历史重建"} <span>·</span> 来源更新 {timestamp(r.sourceUpdatedAt)} <span>·</span> 美东交易日</div>
      <div className={s.metrics}>
        <div><span>独立报道记录</span><strong>{r.totals.records}<small>条</small></strong><p>{r.totals.tickers} 个标的 · 已排除 {r.totals.excluded} 条汇总 / 非研究记录</p></div>
        <div><span>样本权利金</span><strong>{money(r.totals.premium)}</strong><p>金额可归属 {r.totals.priced} / {r.totals.records} 条</p></div>
        <div><span>前三标的集中度</span><strong>{r.totals.top3 == null ? "—" : r.totals.top3.toFixed(1)}<small>%</small></strong><p>按标的汇总已知权利金</p></div>
        <div><span>重复出现</span><strong>{r.totals.repeat}<small>个</small></strong><p>近 20 个交易日已观察记录</p></div>
      </div>
      <div className={s.read}><span>DAILY READ</span><p>{r.read}</p></div>
      <div className={s.split}>
        <section className={s.panel}>
          <Heading n="01 / CONCENTRATION" title="主题集中度" sub="每个标的只计入一个主主题" />
          {r.themes.length ? r.themes.map(t => <div key={t.name} className={s.theme}>
            <div><strong>{t.name}</strong><span>{money(t.premium)} <small>{r.totals.premium > 0 ? `${(t.premium / r.totals.premium * 100).toFixed(1)}%` : "—"}</small></span></div>
            <div className={s.track}><i style={{ width: `${r.totals.premium ? t.premium / r.totals.premium * 100 : 0}%` }} /></div>
            <p>{t.tickers.join(" / ")} <span>· {t.count} 条</span></p>
          </div>) : <p className={s.empty}>暂无可归类记录</p>}
        </section>
        <section className={s.panel}>
          <Heading n="02 / STRUCTURE" title="来源方向标签" sub="成交结构标签，不代表真实持仓意图" />
          {[["偏多结构", r.totals.bull, s.up], ["偏空结构", r.totals.bear, s.down], ["方向未分类", r.totals.unknown, s.gold]].map(([label, value, color]) => <div key={label} className={s.direction}><span>{label}</span><strong className={String(color)}>{money(Number(value))}</strong></div>)}
          <p className={s.explain}>买 Call / 卖 Put 归为偏多；买 Put / 卖 Call 归为偏空。缺少明确买卖方的记录保留为未分类。</p>
          <div className={s.quality}><span>个股 RPS 覆盖</span><strong>{r.coverage.rps} / {r.coverage.stocks}</strong><span>近 5 日有来源消息</span><strong>{r.coverage.observed5} / {r.coverage.expected5}</strong></div>
          <p className={s.explain}>采集完整性尚未认证；没有报道不等于没有交易。OI、成交量及执行类型暂未核验。</p>
        </section>
      </div>
      <section className={s.section}>
        <Heading n="03 / FLOW × STRENGTH" title="异常流与个股强度" sub="RPS 使用当日收盘；Δ 为交易日排名变化" />
        <div className={s.toolbar}><div className={s.filters}>{["全部", "强势改善", "强度偏弱", "重复出现"].map(f => <button key={f} className={filter === f ? s.active : ""} onClick={() => setFilter(f)} aria-pressed={filter === f}>{f}</button>)}</div><label className={s.search}><Search size={15} /><input aria-label="搜索标的" placeholder="搜索标的" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
        <div className={s.tableWrap}><table><thead><tr>{["标的 / 主题", "权利金", "方向", "RPS", "Δ 1D", "Δ 5D", "Δ 20D", "当日涨跌", "强度状态", "持续性 / 5D · 20D"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(p => <tr key={p.ticker}>
          <td><strong>{p.ticker}</strong><small>{p.theme}</small></td><td>{money(p.premium)}</td><td>{p.direction}</td><td><Rps p={p} /></td>
          {[p.delta1, p.delta5, p.delta20].map((v, i) => <td key={i} className={tone(v)}>{signed(v)}</td>)}<td className={tone(p.change)}>{signed(p.change, true)}</td><td><span className={p.strength === "强势改善" ? s.badgeGood : s.badge}>{p.strength}</span></td>
          <td>{p.persistence}<small>{p.days5} / 5 日 · {p.days20} / 20 日 · 连续 {p.consecutive} 日</small></td>
        </tr>)}</tbody></table>{!rows.length && <div className={s.empty}>没有符合当前筛选条件的标的</div>}</div>
        <p className={s.footnote}>高 RPS ≥ 80；改善 = Δ5D &gt; 0。ETF / 指数单独归类。首次观察仅指近 20 个交易日内首次被本来源报道。</p>
      </section>
      <section className={s.section}>
        <Heading n="04 / CASE FILES" title="重点观察" sub="按已知权利金排序，展示前 5 个标的" />
        <div className={s.cases}>{r.profiles.slice(0, 5).map((p, i) => <article key={p.ticker} className={s.case}>
          <div className={s.caseTop}><span>0{i + 1}</span><span>{p.persistence}</span></div><h3>{p.ticker}<small>{money(p.premium)}</small></h3><p>{p.theme}</p>
          <dl><div><dt>RPS / Δ5D</dt><dd>{number(p.rps)} <span className={tone(p.delta5)}>{signed(p.delta5)}</span></dd></div><div><dt>盘中可用前日 RPS</dt><dd>{number(p.priorRps)}</dd></div><div><dt>方向 / 强度</dt><dd>{p.direction} · {p.strength}</dd></div></dl>
          {r.events.find(e => e.ticker === p.ticker && e.sourceUrl)?.sourceUrl && <a target="_blank" rel="noreferrer" href={r.events.find(e => e.ticker === p.ticker && e.sourceUrl)!.sourceUrl!}>查看来源 <ArrowUpRight size={13} /></a>}
        </article>)}</div>
      </section>
      <section className={s.section}>
        <Heading n="05 / FOLLOW THROUGH" title="事后跟踪" sub={`截至 ${r.date} · 近 20 份日报 · 股票价格表现`} />
        <p className={s.explain}>以报道后下一交易日开盘价为观察基准；T+1 / 5 / 10 为对应交易日收盘收益。MFE / MAE 为完整 10 日内最大有利 / 不利变动。这里不是期权组合的盈亏。</p>
        <div className={s.cohorts}>{groups.map(g => <div key={g.strength}><span>{g.strength}</span><strong className={tone(g.avg)}>{signed(g.avg, true)}</strong><small>T+5 均值 · {g.count} 个已成熟样本<br />超额 SPY {signed(g.excess, true)}</small></div>)}</div>
        <details className={s.details}><summary>查看跟踪明细 <span>{outcomes.length} 个标的日样本</span></summary><div className={s.tableWrap}><table><thead><tr>{["报道日期", "标的", "当日强度", "T+1", "T+5", "T+10", "超额 SPY 5D", "MFE 10D", "MAE 10D", "状态"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{outcomes.map(o => <tr key={`${o.date}/${o.ticker}`}><td>{o.date}</td><td><strong>{o.ticker}</strong></td><td>{o.strength}</td>{[o.t1, o.t5, o.t10, o.excess5, o.mfe, o.mae].map((v, i) => <td key={i} className={tone(v)}>{signed(v, true)}</td>)}<td>{o.status}</td></tr>)}</tbody></table></div>{!outcomes.length && <p className={s.empty}>等待后续交易日行情，尚无可评价样本。</p>}</details>
        <p className={s.footnote}>分组均值仅作描述；重复标的并非独立样本，尚未完成同板块 / 相近 RPS 的匹配对照，不能据此认定预测有效。</p>
      </section>
      <details className={s.details}><summary>原始记录与数据口径 <span>{r.events.length} 条 · 可追溯来源</span></summary>
        <div className={s.tableWrap}><table><thead><tr>{["标的", "合约", "来源买卖方", "权利金", "报道时间", "核验状态", "来源"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{r.events.map(e => <tr key={e.id}><td><strong>{e.ticker}</strong></td><td>{e.strike ?? "—"} {e.right.toUpperCase()}<small>{e.expiry ?? "到期日未知"}</small></td><td>{e.side === "buyer" ? "买方" : e.side === "seller" ? "卖方" : "未明"}</td><td>{money(e.premium)}</td><td>{timestamp(e.postedAt)}</td><td>{e.flags.join(" · ") || "按来源记录"}</td><td>{e.sourceUrl ? <a target="_blank" rel="noreferrer" href={e.sourceUrl}>原文 ↗</a> : "无链接"}</td></tr>)}</tbody></table></div>
        <ul className={s.method}><li>样本来自 FL0WG0D 报道，不是全市场成交带；记录数不等于交易所成交笔数，权利金不等于名义本金或净流入。</li><li>同一原文跨频道只留一次；汇总、OI 确认与暗池消息排除。不同来源记录不按相近金额强行合并，无法识别的复述仍可能存在。</li><li>持续出现 = 近 5 个交易日出现 ≥ 3 日；再次出现 = 近 20 日出现 ≥ 2 日。连续天数单独计算。</li><li>历史 RPS 依现有日线与对应日标尺重建；分类映射采用当前版本，存在数据修订与历史成分口径限制。</li><li>生成 {timestamp(r.builtAt)} · 规则 {r.ruleVersion}。盘中原始采集继续运行，研究归档随收盘任务每日更新。</li></ul>
      </details>
      {r.warnings.length > 0 && <aside className={s.notice}><strong>数据待补充</strong><ul>{r.warnings.map(w => <li key={w}>{w}</li>)}</ul></aside>}
    </>}
  </div>;
}
