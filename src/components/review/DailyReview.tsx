"use client";

import { Disclosure } from "@/components/Disclosure";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionIcon, Pagination, SegmentedControl, Select, TextInput } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ScanLine,
} from "lucide-react";
import type {
  DailyReview as Review,
  JournalSignal,
  Outcome,
  ReviewAccount,
  SectorStrength,
} from "@/lib/review/types";
import { cohort, correlation, type Cohort } from "@/lib/review/journal";
import styles from "./review.module.css";
import { OptionsMarketMap } from "./OptionsMarketMap";
import { TomorrowMap } from "./TomorrowMap";
import { OptionsSignalStudy, FrozenSignalOptions } from "./OptionsSignalStudy";
import { MarketStatePanel, contextLabel } from "./MarketStatePanel";
import { AnalystNote } from "./AnalystNote";
import type { AnalysisView } from "@/lib/review/analysis/types";
import { CatalystToday } from "./CatalystBrief";
import type { CatalystReviewView } from "@/lib/catalyst/reviewDigest";

const number = (v: number | null | undefined, digits = 2) =>
  v == null
    ? "—"
    : v.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const signed = (v: number | null | undefined, suffix = "%", digits = 2) =>
  v == null
    ? "—"
    : `${Number(v.toFixed(digits)) > 0 ? "+" : ""}${number(Number(v.toFixed(digits)), digits)}${suffix}`;
const tone = (v: number | null | undefined) =>
  v == null || v === 0 ? styles.muted : v > 0 ? styles.up : styles.down;
const time = (stamp: number | string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(stamp));
const FACTORS = [
  { label: "CVD", name: "量价压力" },
  { label: "RPS", name: "强度" },
  { label: "Position", name: "位置" },
  { label: "Volume", name: "成交分布" },
  { label: "Sector", name: "板块共振" },
];

function Section({
  id,
  n,
  title,
  subtitle,
  children,
  action,
}: {
  id: string;
  n: string;
  title: string;
  subtitle: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section id={id} className={styles.section}>
      <header className={styles.sectionHead}>
        <div className={styles.sectionTitle}>
          <span className={styles.index}>{n}</span>
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className={styles.empty}>
      <ScanLine size={20} aria-hidden />
      <p>{children}</p>
    </div>
  );
}
function Change({
  value,
  suffix = "%",
}: {
  value: number | null | undefined;
  suffix?: string;
}) {
  return (
    <span className={`${styles.numeric} ${tone(value)}`}>
      {signed(value, suffix)}
    </span>
  );
}
function DatePicker({
  dates,
  selected,
}: {
  dates: string[];
  selected?: string;
}) {
  const router = useRouter(),
    i = dates.indexOf(selected ?? dates[0]);
  return (
    <div className={styles.datePicker}>
      <ActionIcon variant="subtle" color="gray" size="sm"
        aria-label="前一份复盘"
        disabled={i < 0 || i >= dates.length - 1}
        onClick={() => router.push(`/?date=${dates[i + 1]}`)}
      >
        <ChevronLeft size={16} />
      </ActionIcon>
      <Select size="xs" searchable w={170}
        aria-label="复盘交易日（美东）"
        leftSection={<CalendarDays size={14} aria-hidden />}
        value={selected ?? dates[0] ?? null}
        placeholder="等待首份复盘" disabled={!dates.length}
        nothingFoundMessage="没有该日期的复盘"
        data={dates}
        onChange={(value) => { if (value) router.push(`/?date=${value}`); }}
      />
      <ActionIcon variant="subtle" color="gray" size="sm"
        aria-label="后一份复盘"
        disabled={i <= 0}
        onClick={() => router.push(`/?date=${dates[i - 1]}`)}
      >
        <ChevronRight size={16} />
      </ActionIcon>
    </div>
  );
}

function Sectors({
  rows: allRows,
  grouped,
}: {
  rows: SectorStrength[];
  grouped: boolean;
}) {
  const [group, setGroup] = useState<"sector" | "industry">("sector");
  const rows = grouped ? allRows.filter((r) => r.group === group) : allRows;
  const [horizon, setHorizon] = useState<"d1" | "d5" | "d20">("d5");
  const sorted = [...rows].sort(
    (a, b) => (b[horizon] ?? -Infinity) - (a[horizon] ?? -Infinity),
  );
  const gainers = sorted
    .filter((s) => s[horizon] != null && s[horizon]! > 0)
    .slice(0, 3);
  const losers = [...sorted]
    .reverse()
    .filter((s) => s[horizon] != null && s[horizon]! < 0)
    .slice(0, 3);
  return (
    <>
      <div className={styles.toolbar}>
        <SegmentedControl size="xs" aria-label="强度变化周期"
          value={horizon} onChange={(value) => setHorizon(value as typeof horizon)}
          data={[{ value: "d1", label: "1D" }, { value: "d5", label: "5D" }, { value: "d20", label: "20D" }]} />
        {grouped && (
          <SegmentedControl size="xs" aria-label="强度排名分组"
            value={group} onChange={(value) => setGroup(value as typeof group)}
            data={[{ value: "sector", label: "11 大板块" }, { value: "industry", label: "3 细分行业" }]} />
        )}
      </div>
      <div className={styles.strengthLeads}>
        {[
          {
            label: "Strength gainers",
            list: gainers,
            icon: ArrowUpRight,
            cls: styles.up,
          },
          {
            label: "Strength losers",
            list: losers,
            icon: ArrowDownRight,
            cls: styles.down,
          },
        ].map((g) => (
          <div key={g.label}>
            <h3 className={g.cls}>
              <g.icon size={16} />
              {g.label}
            </h3>
            {g.list.length ? (
              g.list.map((s) => (
                <div key={s.symbol}>
                  <span>
                    {s.name} <small>{s.symbol}</small>
                  </span>
                  <Change value={s[horizon]} suffix=" pt" />
                </div>
              ))
            ) : (
              <p className={styles.muted}>暂无可核验的变化</p>
            )}
          </div>
        ))}
      </div>
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              <th>板块 / 行业</th>
              <th>今日 RPS</th>
              <th>1D 变化</th>
              <th>5D 变化</th>
              <th>20D 变化</th>
              <th>今日涨跌</th>
            </tr>
          </thead>
          <tbody>
            {[...rows]
              .sort((a, b) => (b.rps ?? -1) - (a.rps ?? -1))
              .map((s) => (
                <tr key={s.symbol}>
                  <td>
                    <b>{s.name}</b> <small>{s.symbol}</small>
                  </td>
                  <td>
                    <div className={styles.rpsCell}>
                      <b>{number(s.rps, 1)}</b>
                      <span>
                        {s.rps != null && <i style={{ width: `${s.rps}%` }} />}
                      </span>
                    </div>
                  </td>
                  <td>
                    <Change value={s.d1} suffix="" />
                  </td>
                  <td>
                    <Change value={s.d5} suffix="" />
                  </td>
                  <td>
                    <Change value={s.d20} suffix="" />
                  </td>
                  <td>
                    <Change value={s.change} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>
        11 个大板块与 3 个细分行业分别按过去 20
        个交易日涨幅排名，组内缺项不缩小分母。RPS
        变化比较同一批标的；样本缺失不缩小分母。与买点评分中个股 RPS
        的口径不同。
      </p>
    </>
  );
}

function Score({ signal: s }: { signal: JournalSignal }) {
  return (
    <span className={styles.score}>
      {number(s.quality.points, 1)}
      {!s.quality.complete && <small> / {s.quality.available} · 未齐</small>}
    </span>
  );
}
function SignalDetail({ signal: s }: { signal: JournalSignal }) {
  return (
    <Disclosure className={styles.signalDetail} title={<>
        {s.symbol} <small>{time(s.signalTime)} ET</small>
      </>}>

      <div>
        <p>
          {s.quality.version.toUpperCase()} · 触发价 ${number(s.price)} ·{" "}
          {s.source === "live" ? "当时留档" : "延迟 / 重放记录"}
        </p>
        {s.quality.dimensions.map((d) => (
          <p key={d.name}>
            <b>
              {d.name} {number(d.points, 1)} / {d.max}
            </b>
            <br />
            {d.reason}
          </p>
        ))}
        <p>
          当时已知市场：
          {s.context
            ? `${contextLabel(s.context)}（${s.context.date} 收盘复盘）`
            : "未留档"}{" "}
          · 板块：{s.sector ?? "未留档"}
        </p>
        <FrozenSignalOptions signal={s} />
      </div>
    </Disclosure>
  );
}
function BuyPoints({ signals }: { signals: JournalSignal[] }) {
  return (
    <div className={styles.buyGrid}>
      {(["2h", "4h"] as const).map((tf) => {
        const rows = signals.filter((s) => s.tf === tf && s.source === "live");
        const complete = rows.filter((s) => s.quality.complete),
          incomplete = rows.length - complete.length;
        const buckets = [
          complete.filter((s) => s.quality.points >= 80).length,
          complete.filter(
            (s) => s.quality.points >= 70 && s.quality.points < 80,
          ).length,
          complete.filter(
            (s) => s.quality.points >= 60 && s.quality.points < 70,
          ).length,
          complete.filter((s) => s.quality.points < 60).length,
        ];
        const ranked = [...rows]
          .sort(
            (a, b) =>
              Number(b.quality.complete) - Number(a.quality.complete) ||
              b.quality.points - a.quality.points,
          )
          .slice(0, 10);
        const legacyRisk = ranked.some(
          (s) => s.quality.version !== "quality-v5",
        );
        return (
          <article key={tf} className={styles.buyPanel}>
            <header>
              <h3>
                {tf.toUpperCase()} <span>Buy points</span>
              </h3>
              <div>
                <b>{rows.length}</b>
                <span>条已留档信号</span>
              </div>
            </header>
            <div className={styles.buckets}>
              {["≥ 80", "70–79", "60–69", "< 60"].map((label, i) => (
                <div key={label}>
                  <b>{buckets[i]}</b>
                  <span>{label} 分</span>
                </div>
              ))}
            </div>
            <p className={styles.note}>
              未齐评分 {incomplete} 条 · 排名使用触发时分数，点股票查看原因。
            </p>
            {ranked.length ? (
              <div className={styles.tableWrap}>
                <table className={styles.factorTable}>
                  <thead>
                    <tr>
                      <th>Top 10</th>
                      <th>总分</th>
                      {FACTORS.map((f) => (
                        <th key={f.name}>
                          {f.label === "Sector" && legacyRisk
                            ? "Sector / 止损*"
                            : f.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <SignalDetail signal={s} />
                        </td>
                        <td>
                          <Score signal={s} />
                          <small className={styles.version}>
                            {s.quality.version.replace("quality-", "")}
                          </small>
                        </td>
                        {FACTORS.map((f) => {
                          const name =
                            f.name === "量价压力" &&
                            s.quality.version !== "quality-v5"
                              ? "CVD背离"
                              : f.name === "板块共振" &&
                                  s.quality.version !== "quality-v5"
                                ? "风险"
                                : f.name;
                          return (
                            <td key={f.name} title={name}>
                              {number(
                                s.quality.dimensions.find(
                                  (d) => d.name === name,
                                )?.points,
                                1,
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>
                该日还没有收到并留档的 {tf.toUpperCase()}{" "}
                买点。此数量不代表扫描器确认“零买点”。
              </Empty>
            )}
            {legacyRisk && (
              <p className={styles.note}>
                * 旧版最后一项为止损评分；V5
                为板块共振。展开股票可核对完整原始维度，旧版没有的因子保持空缺。
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

function Sparkline({ points }: { points: ReviewAccount["curve"] }) {
  if (points.length < 2) return null;
  const values = points.map((p) => p.equity),
    lo = Math.min(...values),
    hi = Math.max(...values),
    span = hi - lo || 1;
  const line = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * 420},${64 - ((v - lo) / span) * 52}`,
    )
    .join(" ");
  return (
    <svg
      viewBox="0 0 420 76"
      className={styles.sparkline}
      role="img"
      aria-label={`最近 ${points.length} 个交易日账本净值曲线`}
    >
      <path d="M0 68H420" stroke="currentColor" opacity=".12" />
      <polyline
        points={line}
        stroke="currentColor"
        fill="none"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
function Account({
  account: a,
  benchmark,
}: {
  account: ReviewAccount;
  benchmark: number | null;
}) {
  return (
    <article className={styles.account}>
      <header>
        <h3>
          {a.tf.toUpperCase()} <span>Strategy account</span>
        </h3>
        <span className={styles.tag}>现金模型账本</span>
      </header>
      <div className={styles.accountReturn}>
        <strong className={tone(a.daily)}>{signed(a.daily)}</strong>
        <div>
          <span>今日</span>
          <small>SPY {signed(benchmark)}</small>
        </div>
      </div>
      <div className={styles.accountStats}>
        <div>
          <span>本月</span>
          <Change value={a.monthly} />
        </div>
        <div>
          <span>当前持仓</span>
          <b>{number(a.holdings, 0)}</b>
        </div>
        <div>
          <span>现金比例</span>
          <b>{a.cashPct == null ? "—" : `${number(a.cashPct, 1)}%`}</b>
        </div>
        <div>
          <span>最大单仓</span>
          <b>{a.maxWeight == null ? "—" : `${number(a.maxWeight, 1)}%`}</b>
        </div>
      </div>
      {a.monthly == null && (
        <p className={styles.accountMonthlyNote}>
          {a.monthlyNote ?? (a.equity == null
            ? "对应交易日净值缺失，暂不计算月收益。"
            : "缺少上月末同口径净值基准，暂不计算月收益。")}
        </p>
      )}
      <Sparkline points={a.curve} />
      <div className={styles.attribution}>
        <h4>今日表现来自哪里</h4>
        {a.daily != null && benchmark != null && (
          <p>
            较 SPY {a.daily >= benchmark ? "领先" : "落后"}{" "}
            {number(Math.abs(a.daily - benchmark))} 个百分点。
          </p>
        )}
        {a.attribution.slice(0, 3).map((c) => (
          <p key={c.symbol}>
            <b>{c.symbol}</b>
            <Change value={c.contribution} suffix=" pp" />
          </p>
        ))}
        {a.attribution.length > 3 && (
          <p>
            <span>其余全天持仓</span>
            <Change
              value={a.attribution
                .slice(3)
                .reduce((sum, c) => sum + c.contribution, 0)}
              suffix=" pp"
            />
          </p>
        )}
        {a.residual != null && (
          <p>
            <span>交易及未归因部分</span>
            <Change value={a.residual} suffix=" pp" />
          </p>
        )}
        <small>{a.note}</small>
      </div>
      <footer>
        行情截至 {a.asOf?.replace("T", " ") ?? "未生成"}{" "}
        <Link href="/fund">
          查看账本 <ArrowRight size={13} />
        </Link>
      </footer>
    </article>
  );
}

function Result({ outcome: o }: { outcome: Outcome }) {
  return o.status === "ready" ? (
    <Change value={o.value} />
  ) : (
    <span className={styles.pending}>
      {o.status === "pending" ? "待成熟" : "缺行情"}
    </span>
  );
}
function CohortTable({ rows }: { rows: Cohort[] }) {
  return (
    <div className={styles.tableWrap}>
      <table>
        <thead>
          <tr>
            <th>样本组</th>
            <th>已成熟 / 待成熟 / 缺数据</th>
            <th>T+5 均值</th>
            <th>T+5 上涨比例</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td>
                {r.n} / {r.pending} / {r.missing}
              </td>
              <td>
                <Change value={r.mean} />
              </td>
              <td>{r.winRate == null ? "—" : `${number(r.winRate, 1)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SignalJournal({
  signals,
  previousDate,
  date,
}: {
  signals: JournalSignal[];
  previousDate: string | null;
  date: string;
}) {
  const [tf, setTf] = useState("all"),
    [version, setVersion] = useState(
      [...new Set(signals.map((s) => s.quality.version))].sort().at(-1) ??
        "quality-v5",
    ),
    [minScore, setMinScore] = useState("0");
  const [symbol, setSymbol] = useState(""),
    [source, setSource] = useState("live"),
    [page, setPage] = useState(0),
    [since, setSince] = useState("");
  const versions = [
    ...new Set(["quality-v5", ...signals.map((s) => s.quality.version)]),
  ]
    .sort()
    .reverse();
  const filtered = useMemo(
    () =>
      signals.filter(
        (s) =>
          (tf === "all" || s.tf === tf) &&
          s.quality.version === version &&
          s.source === source &&
          (!since || s.date >= since) &&
          s.symbol.includes(symbol.trim().toUpperCase()) &&
          (Number(minScore) === 0 ||
            (s.quality.complete && s.quality.points >= Number(minScore))),
      ),
    [signals, tf, version, source, symbol, minScore, since],
  );
  const study = filtered.filter((s) => s.quality.complete);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 20)),
    currentPage = Math.min(page, pageCount - 1);
  const yesterday = signals.filter(
    (s) => s.date === previousDate && s.source === "live",
  );
  const readyYesterday = yesterday.filter(
    (s) => s.outcomes.t1.status === "ready",
  );
  const groups = [
    cohort("全部完整评分", study),
    cohort(
      "≥ 80 分",
      study.filter((s) => s.quality.points >= 80),
    ),
    cohort(
      "≥ 90 分",
      study.filter((s) => s.quality.points >= 90),
    ),
    ...["2h", "4h"].map((t) =>
      cohort(
        t.toUpperCase(),
        study.filter((s) => s.tf === t),
      ),
    ),
  ];
  const regimes = [...new Set(study.map((s) => contextLabel(s.context)))];
  const sectors = [...new Set(study.map((s) => s.sector ?? "未留档"))];
  const factors = [
    ...new Set(
      filtered.flatMap((s) => s.quality.dimensions.map((d) => d.name)),
    ),
  ];
  return (
    <>
      <div className={styles.journalHeadline}>
        <div>
          <span>上一交易日信号 · {previousDate ?? "—"}</span>
          <strong>
            {readyYesterday.length
              ? `${readyYesterday.filter((s) => s.outcomes.t1.value! > 0).length} / ${readyYesterday.length}`
              : "—"}
            <small>T+1 上涨 / 已有结果</small>
          </strong>
        </div>
        <p>
          记录每一次判断，也保留失败。
          <br />
          <span>截至 {date} 收盘 · 待成熟与缺行情不进入收益分母</span>
        </p>
      </div>
      <div className={styles.filters}>
        <Select label="周期" size="xs" value={tf}
          data={[{ value: "all", label: "2H + 4H" }, { value: "2h", label: "2H" }, { value: "4h", label: "4H" }]}
          onChange={(value) => { if (value) { setTf(value); setPage(0); } }} />
        <Select label="评分版本" size="xs" value={version} data={versions}
          onChange={(value) => { if (value) { setVersion(value as JournalSignal["quality"]["version"]); setPage(0); } }} />
        <Select label="最低评分" size="xs" value={minScore}
          data={[0, 60, 70, 80, 90].map((n) => ({ value: String(n), label: n === 0 ? "全部" : `≥ ${n} 分` }))}
          onChange={(value) => { if (value !== null) { setMinScore(value); setPage(0); } }} />
        <Select label="来源" size="xs" value={source}
          data={[{ value: "live", label: "实时留档" }, { value: "replay", label: "延迟 / 重放" }]}
          onChange={(value) => { if (value) { setSource(value); setPage(0); } }} />
        <DatePickerInput label="起始日" size="xs" value={since || null} maxDate={date}
          placeholder="全部日期" clearable leftSection={<CalendarDays size={14} />} aria-label="起始日"
          clearButtonProps={{ "aria-label": "清除起始日" }}
          onChange={(value) => { setSince(value ?? ""); setPage(0); }} />
        <TextInput label="股票" size="xs" placeholder="搜索代码" aria-label="搜索股票代码" value={symbol}
          onChange={(event) => { setSymbol(event.currentTarget.value); setPage(0); }} />
      </div>
      {filtered.length ? (
        <>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>日期 / 股票</th>
                  <th>周期</th>
                  <th>买点分数</th>
                  <th>T+1</th>
                  <th>T+3</th>
                  <th>T+5</th>
                  <th>MFE · 5D</th>
                  <th>MAE · 5D</th>
                </tr>
              </thead>
              <tbody>
                {filtered
                  .slice(currentPage * 20, currentPage * 20 + 20)
                  .map((s) => {
                    const last = s.excursions.at(-1),
                      complete =
                        s.outcomes.t5.date != null &&
                        s.outcomes.t5.date <= date &&
                        s.excursions.length === 5;
                    return (
                      <tr key={s.id}>
                        <td>
                          <small>{s.date}</small>
                          <SignalDetail signal={s} />
                        </td>
                        <td>{s.tf.toUpperCase()}</td>
                        <td>
                          <Score signal={s} />
                        </td>
                        <td>
                          <Result outcome={s.outcomes.t1} />
                        </td>
                        <td>
                          <Result outcome={s.outcomes.t3} />
                        </td>
                        <td>
                          <Result outcome={s.outcomes.t5} />
                        </td>
                        <td>
                          <Change value={last?.mfe} />
                          {!complete && (
                            <small className={styles.version}>观察中</small>
                          )}
                        </td>
                        <td>
                          <Change value={last?.mae} />
                          {!complete && (
                            <small className={styles.version}>观察中</small>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <div className={styles.pagination}>
            <span>{filtered.length} 条记录</span>
            <Pagination size="xs" total={pageCount} value={currentPage + 1}
              onChange={(value) => setPage(value - 1)} siblings={0} boundaries={1}
              getControlProps={(control) => ({ "aria-label": control === "previous" ? "上一页" : "下一页" })}
              getItemProps={(page) => ({ "aria-label": `第 ${page} 页` })} />
          </div>
        </>
      ) : (
        <Empty>
          当前筛选下没有留档信号。历史未保存的评分不会用今天的指标补写。
        </Empty>
      )}
      <div className={styles.study}>
        <h3>
          系统事后验证 <span>同版本 · 同来源 · T+5</span>
        </h3>
        <CohortTable rows={groups} />
        <Disclosure className={styles.research} title={<>展开：因子相关性、市场状态与板块表现</>}>

          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>因子</th>
                  <th>有效样本</th>
                  <th>与 T+5 收益的相关系数</th>
                </tr>
              </thead>
              <tbody>
                {factors.map((name) => {
                  const c = correlation(study, name);
                  return (
                    <tr key={name}>
                      <td>{name}</td>
                      <td>{c.n}</td>
                      <td>
                        {c.r == null
                          ? c.n < 20
                            ? "至少需要 20 个成熟样本"
                            : "分数或收益无差异，无法计算"
                          : number(c.r, 3)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <h4>信号前已知的市场状态</h4>
          <CohortTable
            rows={regimes.map((r) =>
              cohort(
                r,
                study.filter((s) => contextLabel(s.context) === r),
              ),
            )}
          />
          <h4>触发时留档的板块</h4>
          <CohortTable
            rows={sectors.map((r) =>
              cohort(
                r,
                study.filter((s) => (s.sector ?? "未留档") === r),
              ),
            )}
          />
        </Disclosure>
      </div>
      <OptionsSignalStudy signals={filtered} date={date} />
      <p className={styles.note}>
        收益以信号触发价为基准，观察后续第 1 / 3 / 5 个交易日收盘。MFE / MAE
        为后续五个交易日的最高 / 最低价格相对变化（含
        0，不包含信号当日）。价格统一到触发时股数单位，不含现金分红、成本和滑点，因此不是成交策略收益。相关性仅用于研究，同一日及同股信号可能相关，不能当成独立样本或因果证据。
      </p>
    </>
  );
}

export function DailyReview({
  review: r,
  dates,
  journal,
  error,
  analysis = { report: null, status: "missing" },
  catalyst = { digest: null, status: "missing" },
}: {
  review: Review | null;
  dates: string[];
  journal: JournalSignal[];
  error: string | null;
  analysis?: AnalysisView;
  catalyst?: CatalystReviewView;
}) {
  return (
    <div className={styles.review}>
      <header className={styles.masthead}>
        <div>
          <p className={styles.eyebrow}>THE DAILY BRIEF / TREND ADAPTIVE</p>
          <h1>
            每日复盘<span>Market review</span>
          </h1>
        </div>
        <DatePicker dates={dates} selected={r?.date} />
      </header>
      {error && (
        <div role="status" className={styles.notice}>
          {error}
        </div>
      )}
      {!r ? (
        <Empty>
          市场状态、期权结构、板块强度、买点、账户和信号验证将在首份复盘生成后展示。
        </Empty>
      ) : (
        <>
          <div className={styles.edition}>
            <span>
              美东交易日 {r.date} · 对比 {r.previousDate ?? "—"}
            </span>
            <span>生成于 {time(r.builtAt)} ET</span>
          </div>
          <nav className={styles.anchors} aria-label="复盘章节">
            {[
              ["market", "市场状态"],
              ["catalyst-today", "事件线索"],
              ["options", "Options map"],
              ["sectors", "板块强度"],
              ["signals", "买点"],
              ["accounts", "账户"],
              ["journal", "事后验证"],
              ["tomorrow", "明日关注"],
              ["analysis", "AI 解读"],
            ].map(([id, text]) => (
              <a key={id} href={`#${id}`}>
                {text}
              </a>
            ))}
          </nav>
          <MarketStatePanel review={r} />
          <CatalystToday catalyst={catalyst} />
          <Section
            id="options"
            n="02"
            title="Options market map"
            subtitle="看关键结构怎样移动，而不只看它在哪里。"
          >
            <OptionsMarketMap rows={r.options} />
          </Section>
          <Section
            id="sectors"
            n="03"
            title="板块轮动与市场强度"
            subtitle="谁在变强，谁在失去相对优势。"
          >
            <Sectors rows={r.sectors} grouped={!!r.market.engine} />
          </Section>
          <Section
            id="signals"
            n="04"
            title="买点复盘"
            subtitle="保留系统在当时的判断。CVD / RPS / Position / Volume / Sector。"
          >
            <BuyPoints signals={r.signals} />
            <p className={styles.note}>
              当前 V5 权重：CVD 20、RPS 30、Position 25、Volume 10、Sector
              15。CVD
              是分钟量价压力估算，不是逐笔买卖单净流入。旧版本保留原维度和权重；不完整分数不折算成满分。
            </p>
          </Section>
          <Section
            id="accounts"
            n="05"
            title="Live strategy performance"
            subtitle="两个持续记账的现金策略账户，连接信号与实际模型表现。"
          >
            <div className={styles.accountsGrid}>
              {r.accounts.map((a) => (
                <Account
                  key={a.tf}
                  account={a}
                  benchmark={
                    r.market.metrics.find((m) => m.symbol === "SPY")?.change ??
                    null
                  }
                />
              ))}
            </div>
            <p className={styles.note}>
              这是系统模型账本，不是券商实盘。日收益对比前一交易日净值；月收益对比上月最后一个已记账交易日。缺少起点时显示“—”，不从当前持仓倒推历史。
            </p>
          </Section>
          <Section
            id="journal"
            n="06"
            title="Signal journal"
            subtitle="系统过去说过什么，后来发生了什么。"
          >
            <SignalJournal
              key={r.date}
              signals={journal}
              previousDate={r.previousDate}
              date={r.date}
            />
          </Section>
          <Section
            id="tomorrow"
            n="07"
            title="Tomorrow map"
            subtitle="从今日变化中，提取下一交易日值得继续观察的事。"
          >
            <TomorrowMap review={r} catalyst={catalyst} />
          </Section>
          <Section
            id="analysis"
            n="08"
            title="AI Analyst Note"
            subtitle="每日复盘后的独立解读，保留当次分析与数据依据。"
          >
            <AnalystNote analysis={analysis} />
          </Section>
          <Disclosure className={styles.method} title={<>
              <CircleHelp size={16} />
              数据与判定口径{" "}
              {r.warnings.length > 0 && (
                <span>{r.warnings.length} 项数据提示</span>
              )}
            </>}>

            <div>
              <p>
                状态规则：SPY / QQQ / IWM 同涨、上涨比例 ≥60%、VIX 不涨 →
                Risk-On；三者同跌、上涨比例 ≤40%、VIX 不跌 →
                Risk-Off；指数方向分化 → Rotation；其余数据完整场景 →
                Transition。数据不足不判定。阈值是描述规则，不是已校准的盈利概率。
              </p>
              <p>
                收益统计分版本、分实时与重放来源；不完整评分不进入分数组。市场状态分组使用信号之前已发布的复盘，缺失时不补写当日收盘状态。历史成分表若未留档，广度仅代表标注日期的名单。
              </p>
              {r.warnings.map((w, i) => (
                <p key={i} className={styles.warning}>
                  {w}
                </p>
              ))}
            </div>
          </Disclosure>
          <footer className={styles.footer}>
            <span>TREND ADAPTIVE / DAILY REVIEW</span>
            <span>记录事实，检验判断。</span>
          </footer>
        </>
      )}
    </div>
  );
}
