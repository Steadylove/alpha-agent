import type { DailyReview, MarketContext } from "@/lib/review/types";
import styles from "./review.module.css";
import css from "./marketState.module.css";

const n = (x: number | null | undefined, digits = 1) =>
  x == null
    ? "—"
    : x.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const signed = (x: number | null | undefined, suffix = "%", digits = 2) =>
  x == null ? "—" : `${x > 0 ? "+" : ""}${n(x, digits)}${suffix}`;
const tone = (x: number | null | undefined) =>
  x == null || x === 0 ? styles.muted : x > 0 ? styles.up : styles.down;
const words: Record<string, string> = {
  "Strong Up": "普遍明显上涨",
  Up: "多数上涨",
  Neutral: "平稳 / 中性",
  Down: "多数下跌",
  "Strong Down": "普遍明显下跌",
  Unknown: "数据不足",
  "Strong Improving": "明显升温",
  Improving: "升温",
  Deteriorating: "降温",
  "Strong Deteriorating": "明显降温",
  Rising: "上升",
  "Mildly Rising": "温和上升",
  Stable: "稳定",
  "Mildly Falling": "温和下降",
  Falling: "下降",
  Broad: "广泛参与",
  Balanced: "参与度均衡",
  Weak: "参与度偏弱",
  "Growth-led": "成长领先",
  "Small-cap-led": "小盘领先",
  "Defensive-led": "防御领先",
  Narrow: "参与集中",
  Mixed: "分化",
  Leading: "领先",
  Confirming: "同步",
  Lagging: "落后",
  Expanding: "扩张",
  Contracting: "收缩",
  Supportive: "利率 / 美元压力减轻",
  Restrictive: "利率 / 美元压力增加",
  Low: "低位",
  Normal: "常态",
  Elevated: "偏高",
  High: "高位",
};
export function contextLabel(context: MarketContext | null) {
  return context
    ? `${context.engine?.state ?? context.regime} · ${context.engine?.version ?? "v1"}`
    : "未留档";
}
export function MarketStatePanel({ review: r }: { review: DailyReview }) {
  const m = r.market,
    e = m.engine,
    macro = m.macro;
  const delta =
    e?.temperature.delta ??
    (m.breadth.today != null && m.breadth.yesterday != null
      ? m.breadth.today - m.breadth.yesterday
      : null);
  return (
    <section id="market" className={`${styles.marketHero} ${css.panel}`}>
      <div className={css.headline}>
        <div className={css.temperature}>
          <p className={styles.eyebrow}>01 / MARKET TEMPERATURE</p>
          <h2>市场体温</h2>
          <div className={css.degree}>
            {n(m.breadth.today)}
            <span>%</span>
          </div>
          <p className={tone(delta)}>
            {signed(delta, " pp", 1)} <small>较前一交易日</small>
          </p>
          <div className={styles.breadthBar}>
            {m.breadth.today != null && (
              <i style={{ width: `${m.breadth.today}%` }} />
            )}
          </div>
          <small>
            {m.breadth.valid} / {m.breadth.total} 只有效样本 · 上涨占比
          </small>
          <p className={css.caption}>
            {e
              ? `${words[e.temperature.level]} · ${words[e.temperature.momentum]}`
              : "原版复盘归档"}
          </p>
        </div>
        <div className={css.state}>
          <div className={css.stateKicker}>
            <span className={styles.eyebrow}>MARKET STATE</span>
            <span>收盘观察</span>
          </div>
          <h2
            className={
              m.regime === "Risk-Off"
                ? styles.down
                : m.regime === "Risk-On"
                  ? styles.up
                  : ""
            }
          >
            {e?.state ?? m.regime}
          </h2>
          {e && <h3>{e.label}</h3>}
          <p className={css.summary}>{m.summary}</p>
          {e && (
            <div className={css.dimensions}>
              <div>
                <small>价格 / PRICE</small>
                <strong>{words[e.price]}</strong>
              </div>
              <div>
                <small>广度变化 / BREADTH</small>
                <strong>{words[e.temperature.momentum]}</strong>
              </div>
              <div>
                <small>波动 / VIX</small>
                <strong>{words[e.volatility.state]}</strong>
                <span>
                  {n(e.volatility.value, 2)} · {words[e.volatility.level]} ·{" "}
                  {signed(e.volatility.change)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className={styles.tickerStrip}>
        {m.metrics.slice(0, 4).map((x) => (
          <div key={x.symbol}>
            <h3>{x.symbol}</h3>
            <strong className={tone(x.change)}>{signed(x.change)}</strong>
            <span>{n(x.today, 2)}</span>
          </div>
        ))}
      </div>
      {e && (
        <div className={css.structure}>
          <div>
            <p className={styles.eyebrow}>MARKET STRUCTURE</p>
            <h3>谁在推动市场</h3>
          </div>
          <div>
            <small>领导结构</small>
            <strong>{words[e.structure.leadership]}</strong>
            <span>{e.structure.leadership}</span>
          </div>
          <div>
            <small>小盘参与</small>
            <strong>{words[e.structure.smallCap]}</strong>
            <span>IWM − SPY {signed(e.structure.smallCapSpread, " pp")}</span>
          </div>
          <div>
            <small>板块扩散 · 11 大板块</small>
            <strong>{words[e.structure.sectorBreadth]}</strong>
            <span>
              1D 上涨 {n(e.structure.sectorUp, 0)} / 11 · 5D{" "}
              {n(e.structure.sector5dUp, 0)} / 11
            </span>
          </div>
        </div>
      )}
      <div className={css.macro}>
        <header>
          <div>
            <p className={styles.eyebrow}>MACRO ENVIRONMENT</p>
            <h3>
              外部环境 <span>{macro?.regime ?? "Unknown"}</span>
            </h3>
          </div>
          <p>
            {macro ? words[macro.regime] : "此份历史复盘未采集宏观环境"}
            {macro?.effectiveDate && (
              <small> · 同日期比较 {macro.effectiveDate}</small>
            )}
          </p>
        </header>
        {macro && (
          <div className={css.macroGrid}>
            {macro.rows.map((x) => (
              <div key={x.id} title={`${x.note}；${x.source}`}>
                <small>{x.label}</small>
                <strong>
                  {n(x.value, x.id === "BTC" ? 0 : 2)}
                  {x.unit === "%" && "%"}
                </strong>
                <span>
                  {x.direction === "Rising"
                    ? "↑"
                    : x.direction === "Falling"
                      ? "↓"
                      : x.direction === "Stable"
                        ? "→"
                        : "—"}{" "}
                  {signed(x.change, x.changeUnit === "bp" ? " bp" : "%")}
                </span>
                <small
                  className={
                    x.status === "stale" || x.status === "missing"
                      ? css.warning
                      : ""
                  }
                >
                  {x.observationDate ?? "无观测"} ·{" "}
                  {
                    {
                      current: "已更新",
                      delayed: "延后发布",
                      stale: "已过期",
                      missing: "缺失",
                    }[x.status]
                  }
                </small>
              </div>
            ))}
          </div>
        )}
        <p className={css.caption}>
          宏观环境独立描述利率与美元压力；商品与 BTC 单列观察。
        </p>
      </div>
      <details className={css.details}>
        <summary>
          判断依据与数据口径
          {e?.basis === "reconstructed" ? " · 历史规则重算" : ""}
        </summary>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>核心指标</th>
                <th>今日</th>
                <th>前一交易日</th>
                <th>变化</th>
              </tr>
            </thead>
            <tbody>
              {m.metrics.map((x) => (
                <tr key={x.symbol}>
                  <td>{x.symbol}</td>
                  <td>{n(x.today, 2)}</td>
                  <td>{n(x.yesterday, 2)}</td>
                  <td>{signed(x.change)}</td>
                </tr>
              ))}
              <tr>
                <td>样本上涨比例</td>
                <td>{n(m.breadth.today)}%</td>
                <td>{n(m.breadth.yesterday)}%</td>
                <td>{signed(delta, " pp", 1)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {e && (
          <>
            <p>{e.version} · 描述性规则初版。阈值尚未进行收益有效性验证。</p>
            <ul>
              {e.evidence.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            {e.missing.length > 0 && (
              <p className={css.warning}>缺项：{e.missing.join("；")}</p>
            )}
          </>
        )}
        <p>
          {m.breadth.universe}；名单截至 {m.breadth.membershipAsOf ?? "未知"}
          ，历史重算不代表使用当时成分股。上涨比例不是盈利概率。
        </p>
        <p>
          板块扩散按 11 个大板块日涨幅超过 0.2% 统计；前日{" "}
          {n(e?.structure.sectorPrevious, 0)} 个。20D 上涨且跑赢 SPY
          的强势板块：{n(m.strongSectors.today, 0)} / {m.strongSectors.total}
          。细分行业单独排名。
        </p>
        {macro && (
          <>
            <ul>
              {macro.evidence.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <p>
              {macro.basis === "reconstructed"
                ? "宏观历史为当前可取得数据的重建，并非当时发布记录。"
                : "数据可见时间采用本系统首次获取时刻，可能晚于供应商发布。"}
              利率变化使用 bp；BTC 是 UTC 自然日收盘；期货换月可能影响涨跌。
            </p>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>指标 / 来源</th>
                    <th>观测日</th>
                    <th>前次观测</th>
                    <th>系统首次可见（UTC）</th>
                  </tr>
                </thead>
                <tbody>
                  {macro.rows.map((x) => (
                    <tr key={x.id}>
                      <td>
                        {x.label}
                        <br />
                        <small>{x.source}</small>
                      </td>
                      <td>{x.observationDate ?? "—"}</td>
                      <td>{x.previousDate ?? "—"}</td>
                      <td>
                        {x.availableAt?.replace("T", " ").replace("Z", "") ??
                          "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {r.publishedMarket && (
          <p>
            首次发布的状态：
            {r.publishedMarket.market.engine?.state ??
              r.publishedMarket.market.regime}
            （{r.publishedMarket.builtAt}
            ）。页面重算不会替换买点中已经冻结的市场上下文。
          </p>
        )}
      </details>
    </section>
  );
}
