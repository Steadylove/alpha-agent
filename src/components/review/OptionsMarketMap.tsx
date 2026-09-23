import type { OptionsRow } from "@/lib/review/types";
import { optionsRowForDisplay } from "@/lib/review/options";
import {
  FLIP_LABEL,
  WALL_LABEL,
  GAMMA_LABEL,
  optionsStructure,
  type OptionsStructure,
} from "@/lib/options/structure";
import { formatEtFromUtc, formatEtStamp } from "@/lib/discord/cardTime";
import styles from "./optionsMap.module.css";

const number = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const signed = (n: number | null | undefined, suffix = "") =>
  n == null
    ? "—"
    : `${Number(n.toFixed(2)) > 0 ? "+" : ""}${number(Number(n.toFixed(2)) || 0)}${suffix}`;
const gex = (n: number | null | undefined) =>
  n == null
    ? "—"
    : `${n < 0 ? "−" : "+"}$${number(Math.abs(n) / (Math.abs(n) >= 1e9 ? 1e9 : 1e6))}${Math.abs(n) >= 1e9 ? "B" : "M"}`;
const roles: Record<string, string> = {
  SPX: "核心指数",
  SPY: "大盘 ETF",
  QQQ: "成长 / 科技",
  IWM: "小盘参与",
};
const gammaTone = (s: OptionsStructure) =>
  s.gamma === "positive"
    ? styles.positive
    : s.gamma === "negative"
      ? styles.negative
      : styles.muted;
const quoteTime = (s?: string) =>
  !s
    ? "时间未知"
    : /(Z|[+-]\d{2}:?\d{2})$/.test(s)
      ? formatEtFromUtc(s)
      : formatEtStamp(s);
const labels = {
  gamma_flip: "Gamma Flip",
  put_wall: "Put Wall",
  call_wall: "Call Wall",
  net_gex: "Net GEX",
};

function Card({ row }: { row: OptionsRow & { structure: OptionsStructure } }) {
  const s = row.structure;
  const prior = row.comparable
    ? optionsStructure(row.previous, row.previousMeta)
    : null;
  return (
    <article className={styles.card} aria-label={`${row.symbol} 期权结构`}>
      <header className={styles.cardHeader}>
        <div>
          <h3>{row.symbol}</h3>
          <span>{roles[row.symbol]}</span>
        </div>
        <span>
          {row.today ? `${row.dte ?? "到期范围未知"} · 延时` : "快照缺失"}
        </span>
      </header>
      <div className={styles.spot}>
        {number(s.values.spot)}
        <span>Current</span>
      </div>
      <div className={styles.distanceRow}>
        <span>
          距 Flip <b>{signed(s.distances.flip, "%")}</b>
        </span>
        <span>
          距 Put <b>{signed(s.distances.put, "%")}</b>
        </span>
        <span>
          距 Call <b>{signed(s.distances.call, "%")}</b>
        </span>
      </div>
      <table className={styles.levels} aria-label={`${row.symbol} 关键价位`}>
        <thead>
          <tr>
            <th>结构</th>
            <th>今日</th>
            <th>较前日</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(labels) as (keyof typeof labels)[]).map((field) => {
            const value = s.values[field],
              old = prior?.values[field];
            const delta = value != null && old != null ? value - old : null;
            return (
              <tr key={field}>
                <th scope="row">{labels[field]}</th>
                <td className={field === "net_gex" ? gammaTone(s) : undefined}>
                  {field === "net_gex" ? gex(value) : number(value)}
                </td>
                <td>{field === "net_gex" ? gex(delta) : signed(delta)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.shifts}>
        <h4>
          Structure shift <span>结构迁移</span>
        </h4>
        {!row.comparable ? (
          <p>缺少相邻交易日的同口径快照，暂不比较。</p>
        ) : (
          row.changes.map((text) => <p key={text}>{text}</p>)
        )}
        {row.comparison === "legacy" && (
          <small>历史来源或方法版本未留档，比较仅供参考。</small>
        )}
      </div>
      {!!s.issues.length && (
        <div className={styles.issues}>
          {s.issues.map((text) => (
            <p key={text}>{text}</p>
          ))}
        </div>
      )}
      <footer>
        {row.today ? quoteTime(row.today.as_of) : "未使用其他交易日价位"}
        <span>
          {s.basis === "reconstructed" ? "历史快照补算" : "当日快照计算"}
        </span>
      </footer>
    </article>
  );
}

export function OptionsMarketMap({ rows }: { rows: OptionsRow[] }) {
  const mapped = rows.map(
    (row) =>
      optionsRowForDisplay(row) as OptionsRow & { structure: OptionsStructure },
  );
  const thresholds = [...new Set(mapped.map((row) => row.structure.nearPct))];
  return (
    <div className={styles.root}>
      <div className={styles.landscape}>
        <div className={styles.landscapeHeader}>
          <h3>Gamma landscape</h3>
          <span>价格位置与 GEX 符号独立判断</span>
        </div>
        <div className={styles.overview}>
          {mapped.map(({ symbol, structure: s }) => (
            <div key={symbol} className={styles.overviewItem}>
              <div className={styles.overviewTitle}>
                <b>{symbol}</b>
                <span className={gammaTone(s)}>{GAMMA_LABEL[s.gamma]}</span>
              </div>
              <strong className={s.flip === "below" ? styles.below : undefined}>
                {FLIP_LABEL[s.flip]}
              </strong>
              <span
                className={
                  s.wall.startsWith("near-") ? styles.near : styles.muted
                }
              >
                {WALL_LABEL[s.wall]}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className={styles.cards}>
        {mapped.map((row) => (
          <Card row={row} key={row.symbol} />
        ))}
      </div>
      <details className={styles.method}>
        <summary>
          计算口径与数据边界 <span>接近阈值 ±{thresholds.join(" / ")}%</span>
        </summary>
        <p>
          距离 =（现价 − 关键价位）÷ 关键价位。±{thresholds.join(" / ")}%
          仅为位置展示阈值，尚未经过收益校准；接近 Flip 不等于 GEX
          近零。双墙间距很小时，可能同时接近两面墙。
        </p>
        <p>
          Cboe 延时期权链估算：Call 正、Put 负；Net GEX 为标的变动 1% 对应的美元
          Gamma 暴露，不代表真实做市商仓位。现价 GEX 使用链上 Gamma，Flip
          使用模型重算，符号和上下位置不强制绑定。
        </p>
        <p>
          墙位优先从现价 ±3% 内选取 Call 上方、Put 下方的最大 Gamma
          档，无近端档位时扩大搜索。价位会随现价、到期滚动、持仓量与隐波变化而重选；移动不等于新增资金。观察突破应使用此前冻结的墙位。
        </p>
        <p>
          SPX 与 SPY 高度相关；四个标的不作为独立投票，也不汇总 GEX
          为市场得分。规则版本
          options-structure-v1；历史补算不是当时已发出的信号。
        </p>
        {mapped.map((row) => (
          <p key={row.symbol}>
            {row.symbol} · 来源 {row.meta?.source ?? "历史未留档"} · 方法{" "}
            {row.meta?.method_version ?? row.meta?.method ?? "历史未留档"} ·
            采集 {row.meta?.fetched_at ?? "未留档"}
          </p>
        ))}
      </details>
    </div>
  );
}
