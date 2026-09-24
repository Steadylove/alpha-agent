"use client";

import { Disclosure } from "@/components/Disclosure";

import { useMemo, useState } from "react";
import { Select } from "@mantine/core";
import type { JournalSignal } from "@/lib/review/types";
import {
  optionsStudy,
  type OptionsStudyRow,
  type StudyHorizon,
} from "@/lib/review/optionsStudy";
import {
  OPTION_SYMBOLS,
  validFrozenOptions,
  OPTIONS_MISSING_LABEL,
  type OptionSymbol,
} from "@/lib/options/signalContext";
import { FLIP_LABEL, WALL_LABEL, GAMMA_LABEL } from "@/lib/options/structure";
import { formatEtFromUtc } from "@/lib/discord/cardTime";
import styles from "./optionsStudy.module.css";

const pct = (n: number | null, signed = true) =>
  n == null ? "—" : `${signed && n > 0 ? "+" : ""}${n.toFixed(2)}%`;

export function FrozenSignalOptions({ signal }: { signal: JournalSignal }) {
  const context = signal.optionsContext;
  const publication = validFrozenOptions(
    context,
    signal.signalTime,
    signal.capturedAt,
  );
  if (!publication)
    return (
      <p className={styles.missing}>
        期权结构：
        {context?.reason
          ? OPTIONS_MISSING_LABEL[context.reason]
          : context
            ? "冻结证据未通过校验"
            : "当时未留档，未用事后数据补写"}
      </p>
    );
  return (
    <div className={styles.frozen}>
      <b>信号前已知的期权结构</b>
      <p>
        {publication.reviewDate} 收盘快照 · 发布于{" "}
        {formatEtFromUtc(publication.publishedAt)}
      </p>
      {publication.items.map((item) => (
        <p key={item.symbol}>
          <strong>{item.symbol}</strong> {FLIP_LABEL[item.structure.flip]} ·{" "}
          {WALL_LABEL[item.structure.wall]} ·{" "}
          {GAMMA_LABEL[item.structure.gamma]}
        </p>
      ))}
      <small>
        使用前一交易日快照，非信号时刻实时 Gamma；每条信号独立冻结。
      </small>
    </div>
  );
}

function StatsRow({ row }: { row: OptionsStudyRow }) {
  return (
    <tr>
      <th scope="row">
        {row.label}
        {row.n > 0 && (row.n < 20 || row.days < 10) && <small>样本较少</small>}
      </th>
      <td>
        {row.n} / {row.pending} / {row.missing}
      </td>
      <td>{row.days}</td>
      <td>{pct(row.mean)}</td>
      <td>{pct(row.median)}</td>
      <td>{pct(row.winRate, false)}</td>
      <td>{pct(row.dayMean)}</td>
      <td>
        {pct(row.mfe)} / {pct(row.mae)}
        <small>{row.excursionN} 条完整 5D 观察</small>
      </td>
    </tr>
  );
}

export function OptionsSignalStudy({
  signals,
  date,
}: {
  signals: JournalSignal[];
  date: string;
}) {
  const [symbol, setSymbol] = useState<OptionSymbol>("SPX");
  const [horizon, setHorizon] = useState<StudyHorizon>("t5");
  const [ruleKey, setRuleKey] = useState("");
  const report = useMemo(
    () => optionsStudy(signals, symbol, horizon, date, ruleKey),
    [signals, symbol, horizon, date, ruleKey],
  );
  const h = horizon.toUpperCase().replace("T", "T+");
  const excluded = report.excluded;
  return (
    <section
      id="options-study"
      className={styles.panel}
      aria-label="期权结构与买点表现"
    >
      <header>
        <div>
          <span>OPTIONS × SIGNALS</span>
          <h3>期权结构与买点表现</h3>
          <p>前一交易日结构 · 下一交易日买点 · 后续实际走势</p>
        </div>
        <div className={styles.coverage}>
          <b>{report.total}</b>
          <span>条同口径冻结记录</span>
        </div>
      </header>
      <div className={styles.filters}>
        <Select label="参考指数" size="xs" value={symbol} data={[...OPTION_SYMBOLS]}
          onChange={(value) => { if (value) { setSymbol(value as OptionSymbol); setRuleKey(""); } }} />
        <Select label="观察周期" size="xs" value={horizon}
          data={[{ value: "t1", label: "T+1" }, { value: "t3", label: "T+3" }, { value: "t5", label: "T+5" }]}
          onChange={(value) => { if (value) setHorizon(value as StudyHorizon); }} />
        <Select label="计算口径" size="xs" value={report.key || null} disabled={!report.variants.length}
          placeholder="等待有效留档"
          data={report.variants.map((v) => ({ value: v.key, label: v.label }))}
          onChange={(value) => { if (value) setRuleKey(value); }} />
      </div>
      <p className={styles.audit}>
        沿用上方周期、评分版本和日期筛选。历史未留档 {excluded.unrecorded} ·
        无效或不可用 {excluded.invalid} · 来源口径不全 {excluded.metadata} ·
        评分未齐 {excluded.incomplete} · 延迟 / 重放 {excluded.replay}
        {report.otherRules > 0 ? ` · 其他计算口径 ${report.otherRules}` : ""}
      </p>
      {report.total ? (
        <>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>结构分组</th>
                  <th>成熟 / 待成熟 / 缺行情</th>
                  <th>成熟交易日</th>
                  <th>{h} 均值</th>
                  <th>{h} 中位数</th>
                  <th>上涨比例</th>
                  <th>交易日等权均值</th>
                  <th>5D MFE / MAE 均值</th>
                </tr>
              </thead>
              <tbody>
                <StatsRow row={report.baseline} />
                {report.groups.map((group) => (
                  <GroupRows
                    key={group.title}
                    title={group.title}
                    rows={group.rows}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.note}>
            同一信号在三个维度各出现一次，各组不能跨维度相加。少于 20
            条成熟记录或 10 个交易日提示“样本较少”，达到该数量也不代表统计显著。
          </p>
        </>
      ) : (
        <div className={styles.empty}>
          <b>等待信号前冻结的期权结构</b>
          <p>
            当前筛选下暂无合格的冻结记录，具体原因见上方计数。未留档的历史买点不能用事后数据补写。新信号留档后将先显示样本数，T+1
            / T+3 / T+5 成熟后再计入收益。
          </p>
        </div>
      )}
      <Disclosure className={styles.method} title={<>如何统计，哪些记录不计入</>}>

        <p>
          仅统计实时留档、评分完整且通过时间校验的信号。结构发布时间和报价时间均不得晚于信号，且必须对应交易日历中的前一交易日。宏观状态
          Unknown 不影响期权上下文独立留档。
        </p>
        <p>
          不同评分版本、数据源、GEX
          方法版本、到期范围、位置阈值分开统计。四个参考指数逐一研究，不当作四份独立样本。未知的单项状态单列。
        </p>
        <p>
          待成熟和缺行情不计入收益分母。交易日等权均值先对同日信号求均值，再对各日求均值，减少信号密集日的权重。5D
          MFE / MAE 只取五个交易日均完整的观察，独立显示样本数。
        </p>
        <p>
          这是标的后续价格变化，不含成交成本，也不是期权组合回测或盈利概率。相同股票与相邻交易日仍可能相关，不据此自动修改五因子权重。
        </p>
      </Disclosure>
    </section>
  );
}

function GroupRows({
  title,
  rows,
}: {
  title: string;
  rows: OptionsStudyRow[];
}) {
  return (
    <>
      <tr className={styles.group}>
        <th colSpan={8}>{title}</th>
      </tr>
      {rows
        .filter((row) => row.total > 0)
        .map((row) => (
          <StatsRow key={row.label} row={row} />
        ))}
    </>
  );
}
