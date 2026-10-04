"use client";

import type { FundamentalSummaryData } from "@/lib/fundamental/types";
import { fundamentalMoney as money, fundamentalPercent as percent, fundamentalTime as time } from "./format";
import { targetSpace } from "./readout";
import { fundamentalUrl } from "./entryContext";
import { FundamentalEntryLink } from "./FundamentalEntryLink";
import s from "./fundamental.module.css";

const labels = { ready: "已核验", stale: "待复核 · 旧版", unavailable: "暂无法估值", pending: "待更新", missing: "尚无留档", error: "读取暂不可用" };

export function FundamentalSummary({ symbol, data, loading = false, entries = [], onEntryOpen }: {
  symbol: string; data?: FundamentalSummaryData; loading?: boolean;
  entries?: { label: string; entryAt: string | null }[];
  onEntryOpen?: (entry: { label: string; entryAt: string | null }) => void;
}) {
  const status = data?.status ?? (loading ? null : "missing");
  const valid = data && data.status !== "error";
  return <section className={s.compact} aria-label={`${symbol} 基本面估值摘要`}>
    <header className={s.summaryHeader}><strong>基本面 · 最新留档</strong><span>{status ? labels[status] : "读取中…"}</span></header>
    {data?.demo && <p className={s.summaryWarning}>测试数据 · 非真实估值结果</p>}
    {valid && data.sixMonth && data.twelveMonth ? <>
      {data.status !== "ready" && <p className={s.summaryWarning}>以下为旧版参考，尚未完成本次核验。</p>}
      <div className={s.summaryGrid}>{([data.sixMonth, data.twelveMonth] as const).map((horizon, i) => {
        const space = targetSpace(horizon.weightedTarget, data.quote?.price ?? null);
        return <div key={i}><span className={s.summaryMuted}>{i === 0 ? "6M" : "12M"} 情景加权目标</span>
          <div className={s.summaryTarget}>{money(horizon.weightedTarget, data.currency)} <small>{space == null ? "空间 —" : `${percent(space)} 空间`}</small></div>
          <span className={s.summaryMuted}>情景区间 {money(horizon.rangeLow, data.currency)} – {money(horizon.rangeHigh, data.currency)}</span>
        </div>;
      })}</div>
      <p className={s.summaryMuted}>{data.method} · 发布 {data.publishedAt ? time(data.publishedAt) : "—"}<br />
        {data.quote ? `空间相对留档价 ${money(data.quote.price, data.currency)}（${time(data.quote.observedAt)}，非实时）` : "报价未留档，暂不计算价格空间"}</p>
    </> : <p className={s.summaryMuted}>{status === "error" ? "估值读取失败，不影响信号和账本。" : loading && !data ? "正在读取已保存的估值…" : "暂无可展示目标；数据核验完成后显示。"}</p>}
    {data?.reasons.length ? <p className={s.summaryWarning}>{data.reasons[0]}</p> : null}
    <p className={s.summaryMuted}>最新估值不代表买点当时已知；2H / 4H 共用，仅作价值参考。</p>
    <div className={s.summaryActions}><a className={s.entryLink} href={fundamentalUrl(symbol)}>完整估值 ↗</a>
      {entries.map((entry, i) => <FundamentalEntryLink key={`${entry.label}-${i}`} symbol={symbol} {...entry}
        onOpen={onEntryOpen ? () => onEntryOpen(entry) : undefined} />)}
    </div>
  </section>;
}
