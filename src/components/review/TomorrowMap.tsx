"use client";

import { Disclosure } from "@/components/Disclosure";

import type { DailyReview } from "@/lib/review/types";
import { SIGNAL_LABELS, STRENGTH_LABELS } from "@/lib/review/followup";
import type { WatchEvent } from "@/lib/review/tomorrow";
import styles from "./tomorrow.module.css";

const dateTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));

function Changes({ events, title }: { events: WatchEvent[]; title: string }) {
  return (
    <div className={styles.group}>
      <h3>{title}</h3>
      {!events.length && (
        <p className={styles.empty}>暂无达到筛选条件的新变化</p>
      )}
      {events.map((e) => (
        <Disclosure className={styles.event} key={e.id} title={<>
            <span>{e.title}</span>
            <span className={styles.more}>查看依据</span>
          </>}>

          <p>{e.evidence}</p>
          <a href={`#${e.source}`}>回到原始数据 ↗</a>
        </Disclosure>
      ))}
    </div>
  );
}

export function TomorrowMap({ review }: { review: DailyReview }) {
  const map = review.tomorrow;
  if (!map)
    return <p className={styles.empty}>等待收盘任务生成下一交易日观察清单。</p>;
  return (
    <div className={styles.root}>
      <div className={styles.dateline}>
        <span>
          {map.targetDate
            ? `FOR ${map.targetDate} · 美东交易日`
            : "下一交易日 · 日期待确认"}
        </span>
        <span>
          {map.events.length} 项变化 ·{" "}
          {map.basis === "published" ? "已发布观察清单" : "历史数据重算"}
        </span>
      </div>
      <div className={styles.changes}>
        <Changes
          title="01 / Market Structure"
          events={map.events.filter((e) => e.group === "market")}
        />
        <Changes
          title="02 / Portfolio & Signal"
          events={map.events.filter((e) => e.group === "portfolio")}
        />
      </div>
      <div className={styles.focus}>
        <div className={styles.focusTitle}>
          <span>03 / TOMORROW FOCUS</span>
          <h3>下一交易日，继续观察</h3>
          <p>按重要性筛选，最多五项。</p>
        </div>
        <ol>
          {map.events.map((e, i) => (
            <li key={e.id}>
              <span className={styles.ordinal}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <b>{e.title}</b>
                <p>{e.focus}</p>
              </div>
            </li>
          ))}
        </ol>
        {!map.events.length && (
          <p className={styles.empty}>
            暂无新增重点。持续状态与完整数据仍可在前面的模块查看。
          </p>
        )}
      </div>
      {review.followup && (
        <Disclosure className={styles.details} title={<>
            信号与模型持仓的每日跟踪 · {review.followup.rows.length} 条
          </>}>

          <p>
            入场评分固定保存。RPS
            每日观察单独记录；“待复核”表示缺少持续有效的确认，不能据此认定信号仍然有效。持仓仅指对应周期模型账户。
          </p>
          <div className={styles.scroll}>
            <table>
              <thead>
                <tr>
                  <th>股票 / 周期</th>
                  <th>信号记录</th>
                  <th>模型持仓</th>
                  <th>入场分</th>
                  <th>今日 RPS</th>
                  <th>强度观察</th>
                  <th>板块 / 分位</th>
                </tr>
              </thead>
              <tbody>
                {review.followup.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.symbol} · {row.tf.toUpperCase()}
                      {row.signalDate && (
                        <small className={styles.rowMeta}>
                          买点 {row.signalDate}
                        </small>
                      )}
                    </td>
                    <td>{SIGNAL_LABELS[row.signal]}</td>
                    <td>
                      {row.position === "held"
                        ? "持有"
                        : row.position === "not-held"
                          ? "未持有"
                          : "待更新"}
                    </td>
                    <td>
                      {row.initialScore ?? "—"}
                      {row.scoreVersion && (
                        <small className={styles.rowMeta}>
                          {row.scoreVersion.replace("quality-", "")}
                        </small>
                      )}
                    </td>
                    <td>{row.rps ?? "—"}</td>
                    <td>{STRENGTH_LABELS[row.strength]}</td>
                    <td>
                      {row.sector
                        ? `${row.sector.name} · ${Math.round(row.sector.percentile * 100)}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {review.followup.warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </Disclosure>
      )}
      {!!map.observations.length && (
        <Disclosure className={styles.details} title={<>上一份观察清单，后来发生了什么</>}>

          <p>仅对照开盘前已发布的清单，记录下一交易日事实，不计算预测胜率。</p>
          {map.observations.map((o) => (
            <div className={styles.observation} key={o.eventId}>
              <b>{o.title}</b>
              <p>{o.text}</p>
            </div>
          ))}
        </Disclosure>
      )}
      <Disclosure className={styles.details} title={<>筛选规则与发布记录 · 第 {map.revision} 版</>}>

        <p>
          固定规则筛选、无 AI
          生成。优先关注持仓变化和市场状态，再看结构、板块与新信号；最多五项，同类最多两项。SPX
          / SPY 结构事件合并筛选。新信号需完整评分且 ≥70
          分，这只是信息筛选门槛。
        </p>
        <p>
          板块需 RPS 变化至少 20 点且当日相对 SPY 同方向变化至少 0.5
          个百分点。期权迁移需同来源、同方法版本；价位迁移阈值
          0.3%，位置状态沿用 Options Map。个股 RPS 单日下降至少 10
          点记为走弱；走弱后回升至少 5 点记为回升。
        </p>
        <p>
          宏观异动阈值：收益率 10 bp、DXY 0.8%、VIX 8%、原油 3%、黄金 2%、BTC
          5%。各自按原始收盘口径比较；这些是初始描述性阈值，未做收益寻优。
        </p>
        {map.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
        <p>
          {map.version} · 首次生成 {dateTime(map.publishedAt)} ET · 最近更新{" "}
          {dateTime(map.updatedAt)} ET · {map.candidateCount} 项候选
        </p>
        {map.history.map((h, i) => (
          <div className={styles.observation} key={`${h.at}-${i}`}>
            <b>{dateTime(h.at)} ET · 修订前清单</b>
            <p>
              {h.events.map((e) => e.title).join("；") || "暂无重点"} ·
              后续修订原因：{h.reason}
            </p>
          </div>
        ))}
      </Disclosure>
      <p className={styles.footnote}>
        用于下一交易日的状态变化追踪。观察顺序不代表盈利概率；模型持仓与信号分别记录。
      </p>
    </div>
  );
}
