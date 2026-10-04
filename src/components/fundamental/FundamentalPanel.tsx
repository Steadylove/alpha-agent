import type { FundamentalHorizon, FundamentalPageData, FundamentalSource, FundamentalValuation } from "@/lib/fundamental/types";
import { peerSensitivity } from "@/lib/fundamental/sensitivity";
import { fundamentalMoney as money, fundamentalPercent as percent, fundamentalSourceUrl, fundamentalTime as time } from "./format";
import { confidenceReadout, formulaReadout, isReportedScenario, targetSpace } from "./readout";
import { ScenarioScale } from "./ScenarioScale";
import s from "./fundamental.module.css";

const labels = { ready: "已保存", stale: "需更新 · 保留上一版", unavailable: "暂无法估值", pending: "等待后台估值" };

function SourceLink({ source }: { source: FundamentalSource }) {
  const url = fundamentalSourceUrl(source.url);
  return url ? <a className={s.link} href={url} target="_blank" rel="noopener noreferrer">{source.label} ↗</a> : <span>{source.label} · 来源链接不可用</span>;
}

function References({ ids, sources }: { ids: string[]; sources: FundamentalSource[] }) {
  return <span>{sources.filter(source => ids.includes(source.id)).map(source => <span key={source.id}> · <SourceLink source={source} /></span>)}</span>;
}

function InlineReferences({ ids, sources }: { ids: string[]; sources: FundamentalSource[] }) {
  return <span className={s.citations}>{sources.flatMap((source, index) => {
    const url = fundamentalSourceUrl(source.url);
    return ids.includes(source.id) && url ? [<a key={source.id} href={url} target="_blank" rel="noopener noreferrer" aria-label={`来源 ${index + 1}：${source.label}`} title={source.label}>[{index + 1}]</a>] : [];
  })}</span>;
}

function InvestorReadout({ value, status }: { value: FundamentalValuation; status: NonNullable<FundamentalPageData["state"]>["analystStatus"] }) {
  const fallback = formulaReadout(value, status), analyst = value.analyst;
  return <section className={s.readout} aria-label="估值解读">
    <p className={s.eyebrow}>{analyst ? "已保存的基本面解读" : "公式依赖说明"}</p>
    <p className={s.readoutSummary}>{analyst?.summary.text ?? fallback.summary}{analyst && <InlineReferences ids={analyst.summary.sourceIds} sources={value.input.sources} />}</p>
    {!analyst && <p className={s.muted}>{fallback.aiStatus}</p>}
    <div className={s.readoutColumns}>
      <div><h3>主要依赖</h3><ul className={s.list}>{analyst ? analyst.drivers.slice(0, 2).map((statement, index) => <li key={index}>{statement.text}<InlineReferences ids={statement.sourceIds} sources={value.input.sources} /></li>) : fallback.dependencies.map(text => <li key={text}>{text}</li>)}</ul></div>
      <div><h3>仍有不确定</h3><ul className={s.list}>{analyst ? analyst.risks.slice(0, 2).map((statement, index) => <li key={index}>{statement.text}<InlineReferences ids={statement.sourceIds} sources={value.input.sources} /></li>) : fallback.uncertainties.map(text => <li key={text}>{text}</li>)}</ul></div>
    </div>
  </section>;
}

function ValuationFacts({ state }: { state: NonNullable<FundamentalPageData["state"]> }) {
  const current = state.current, quote = state.latestQuote ?? current?.input.quote ?? null;
  const price = quote ? current ? money(quote.price, current.input.currency) : `${quote.price.toFixed(2)} · 币种待核验` : "—";
  return <dl className={s.metadata}>
    <div className={s.quoteFact}><dt>已保存报价</dt><dd>{price}<small>{quote ? <><time dateTime={quote.observedAt}>{time(quote.observedAt)}</time> · 非实时</> : "本次没有可用报价"}</small></dd></div>
    <div><dt>最近复核</dt><dd><time dateTime={state.checkedAt}>{time(state.checkedAt)}</time><small>{state.status === "ready" ? "本轮通过模型核验" : "本轮状态见上方提示"}</small></dd></div>
    <div><dt>估值基准日 · UTC</dt><dd>{current?.anchorDate ?? "尚未形成估值"}<small>{current ? `证据采集 ${time(current.input.observedAt)}` : "待完整估值证据留档"}</small></dd></div>
    <div><dt>置信度标记</dt><dd>{current ? confidenceReadout(current) : "未计算"}<small>不是统计计算的置信水平</small></dd></div>
    <div><dt>有效同业</dt><dd>{current ? `${current.peers.length} 家` : "待核验"}<small>{current ? "已通过本版口径核验" : "尚无有效样本留档"}</small></dd></div>
  </dl>;
}

function Horizon({ value, currency, price, previous, reported }: { value: FundamentalHorizon; currency: string; price: number | null; previous: boolean; reported: boolean }) {
  const upside = targetSpace(value.weightedTarget, price);
  return <section className={s.metric} aria-label={`${value.months}M 情景加权目标`}>
    <h3>{value.months}M 情景加权目标 · {value.targetDate}</h3>
    <strong className={s.target}>{money(value.weightedTarget, currency)}</strong>
    <p className={s.range}>Bear – Bull 区间：{money(value.rangeLow, currency)} – {money(value.rangeHigh, currency)}</p>
    {upside != null ? <p className={s.muted}><span className={s.upside}>{percent(upside)}</span>相对{previous ? "该版留档" : "已保存"}报价空间</p> : <p className={s.muted}>报价缺失，暂不计算价格空间。</p>}
    <ScenarioScale value={value} currency={currency} price={price} />
    <p className={s.muted}>{reported ? "目标时点年化盈利能力情景 · 参考窗口" : "盈利窗口"} {value.earningsStart} 至 {value.earningsEnd}</p>
  </section>;
}

function ScenarioTable({ value, currency, reported }: { value: FundamentalHorizon; currency: string; reported: boolean }) {
  return <div className={s.scroll}><table className={s.table}>
    <caption>{value.months}M 情景假设 · 目标日期 {value.targetDate}</caption>
    <thead><tr><th>情景</th><th>{reported ? "情景年化每股盈利" : "EPS"}</th><th>P/E</th><th>目标价</th><th>权重</th></tr></thead>
    <tbody>{(["bear", "base", "bull"] as const).map(key => <tr key={key}><td>{key === "bear" ? "Bear" : key === "base" ? "Base" : "Bull"}</td><td>{money(value[key].eps, currency)}</td><td>{value[key].multiple.toFixed(2)}×</td><td>{money(value[key].target, currency)}</td><td>{(value[key].weight * 100).toFixed(0)}%</td></tr>)}</tbody>
  </table></div>;
}

function ReportedScenarioInputs({ value }: { value: FundamentalValuation }) {
  const scenario = value.input.scenario, assumptions = value.scenarioAssumptions;
  if (!scenario || !assumptions) return null;
  const { current, prior } = scenario, currency = value.input.currency;
  const shares = (count: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(count);
  const periods = [current, prior];
  return <>
    <div className={s.scroll}><table className={s.table}>
      <caption>已披露财报基线 · {currency}</caption>
      <thead><tr><th>字段</th><th>本期 TTM</th><th>上一期 TTM</th></tr></thead>
      <tbody>
        <tr><th scope="row">报告期间</th>{periods.map((period, i) => <td key={i}>{period.periodStart} 至 {period.periodEnd}</td>)}</tr>
        <tr><th scope="row">财报披露</th>{periods.map((period, i) => <td key={i}>{period.filedAt}<InlineReferences ids={period.sourceIds} sources={value.input.sources} /></td>)}</tr>
        <tr><th scope="row">收入</th>{periods.map((period, i) => <td key={i}>{money(period.revenue, currency)}</td>)}</tr>
        <tr><th scope="row">净利润</th>{periods.map((period, i) => <td key={i}>{money(period.netIncome, currency)}</td>)}</tr>
        <tr><th scope="row">净利率</th>{periods.map((period, i) => <td key={i}>{(period.netIncome / period.revenue * 100).toFixed(1)}%</td>)}</tr>
        <tr><th scope="row">经营利润率</th>{periods.map((period, i) => <td key={i}>{(period.operatingIncome / period.revenue * 100).toFixed(1)}%</td>)}</tr>
        <tr><th scope="row">自由现金流 · CFO − CapEx</th>{periods.map((period, i) => <td key={i}>{money(period.operatingCashFlow - period.capex, currency)}</td>)}</tr>
        <tr><th scope="row">最近季度稀释加权股数 · 股</th>{periods.map((period, i) => <td key={i}>{shares(period.dilutedShares)}<small> · 截至 {period.latestQuarterEnd}</small></td>)}</tr>
      </tbody>
    </table></div>
    <dl className={s.record}>
      <dt>观察到的收入同比变化</dt><dd>{percent(assumptions.observedRevenueGrowth * 100)}</dd>
      <dt>情景基准收入</dt><dd>{money(assumptions.baseRevenue, currency)}</dd>
      <dt>情景固定稀释股数</dt><dd>{shares(assumptions.dilutedShares)} 股；两个期限均沿用此假设。</dd>
    </dl>
    <div className={s.scroll}><table className={s.table}>
      <caption>自建情景参数 · 模型假设</caption>
      <thead><tr><th>情景</th><th>年化收入增长率</th><th>净利率</th></tr></thead>
      <tbody>{(["bear", "base", "bull"] as const).map(key => <tr key={key}><td>{key === "bear" ? "Bear" : key === "base" ? "Base" : "Bull"}</td><td>{percent(assumptions.revenueGrowth[key] * 100)}</td><td>{(assumptions.netMargin[key] * 100).toFixed(1)}%</td></tr>)}</tbody>
    </table></div>
    <p className={s.muted}>年化收入 = 基准 TTM 收入 × (1 + 情景增长率)^(月数 / 12)；情景年化每股盈利 = 年化收入 × 情景净利率 ÷ 固定稀释股数。增长率、净利率与固定股数均为模型假设，不是公司指引或外部一致预期。</p>
  </>;
}

function ValuationDetail({ value, historical = false }: { value: FundamentalValuation; historical?: boolean }) {
  const { input } = value;
  const sensitivity = peerSensitivity(value), reported = isReportedScenario(value);
  return <>
    <details className={s.details}><summary>估值方法、盈利与同业依据</summary>
      <dl className={s.record}>
        <dt>主要方法</dt><dd>{value.method} · {reported ? "同业财报市盈率" : "同业预期市盈率"}</dd>
        <dt>盈利口径</dt><dd>{reported ? "已披露 GAAP 财报构成基线；收入增长、净利率与固定稀释股数用于自建年化盈利能力情景。" : "Non-GAAP 分析师共识 EPS；不同于财报 GAAP EPS，同业采用相同口径。"}</dd>
        <dt>辅助核验</dt><dd>财报自由现金流 / 盈利质量；不作为另一套加权目标。</dd>
        <dt>公司与行业</dt><dd>{input.companyName} · {input.sector} / {input.industry}</dd>
        <dt>估值基准日 · UTC</dt><dd>{value.anchorDate} · 置信度 {confidenceReadout(value)}，非统计置信度。</dd>
        <dt>数据采集</dt><dd><time dateTime={input.observedAt}>{time(input.observedAt)}</time></dd>
        <dt>版本有效期</dt><dd>截至 {time(value.validUntil)}；出现重大基本面变化可提前复核。</dd>
        {!reported && input.financials && <><dt>财报报告期</dt><dd>{input.financials.fiscalEnd} · 披露 {input.financials.filedAt}</dd><dt>报告期自由现金流</dt><dd>{money(input.financials.freeCashFlow, input.financials.currency)}</dd></>}
      </dl>
      {reported && <ReportedScenarioInputs value={value} />}
      <ScenarioTable value={value.sixMonth} currency={input.currency} reported={reported} />
      <ScenarioTable value={value.twelveMonth} currency={input.currency} reported={reported} />
      <p className={s.muted}>情景权重是模型预设，不是经过验证的发生概率；情景区间不是统计置信区间。</p>
      <div className={s.scroll}><table className={s.table}><caption>本次同业样本</caption><thead><tr><th>标的</th><th>{reported ? "财报口径每股盈利" : "未来 12 个月 EPS"}</th><th>{reported ? "财报口径 P/E" : "Forward P/E"}</th></tr></thead><tbody>{value.peers.map(peer => <tr key={peer.symbol}><td>{peer.symbol}</td><td>{money(reported ? peer.reportedEps : peer.ntmEps, input.currency)}</td><td>{peer.pe.toFixed(2)}×</td></tr>)}</tbody></table></div>
      {reported && <p className={s.muted}>同业每股盈利 = 已披露 TTM 净利润 ÷ 最近季度稀释加权股数；这是统一股数基准的派生值，不是财报直接披露的 EPS。P/E 使用同一股数口径下的报价计算。</p>}
      {value.assumptions.length > 0 && <><h4>模型假设</h4><ul className={s.list}>{value.assumptions.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
      {input.warnings.length > 0 && <><h4>数据限制</h4><ul className={s.list}>{input.warnings.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
    </details>
    <details className={s.details}><summary>同业样本敏感性 · 研究参考</summary>
      {sensitivity.status === "ready" && sensitivity.low != null && sensitivity.high != null && sensitivity.maxChangePct != null ? <>
        <p>原样本 {sensitivity.sampleCount} 家。逐次剔除一家后，12M 情景加权目标的计算范围为 {money(sensitivity.low, input.currency)} – {money(sensitivity.high, input.currency)}；相对已发布目标的最大绝对偏离为 {sensitivity.maxChangePct.toFixed(1)}%。</p>
        <p className={s.muted}>只观察目标对同业样本选择的敏感程度，不调整已发布目标，不是额外情景或误差区间。</p>
      </> : <p>当前有效同业不足 4 家，剔除一家后无法保留至少 3 家；暂不计算样本敏感性。</p>}
    </details>
    {value.analyst ? <details className={s.details}><summary>完整解读依据 · {value.analyst.model}</summary>
      {historical && <p>{value.analyst.summary.text}<References ids={value.analyst.summary.sourceIds} sources={input.sources} /></p>}
      <h4>支持因素</h4><ul className={s.list}>{value.analyst.drivers.map((statement, i) => <li key={i}>{statement.text}<References ids={statement.sourceIds} sources={input.sources} /></li>)}</ul>
      <h4>不确定因素</h4><ul className={s.list}>{value.analyst.risks.map((statement, i) => <li key={i}>{statement.text}<References ids={statement.sourceIds} sources={input.sources} /></li>)}</ul>
      <p className={s.muted}>解读生成 {time(value.analyst.generatedAt)}；目标价由已留档公式与假设计算。</p>
    </details> : null}
    <details className={s.details}><summary>原始来源与采集时间 · {input.sources.length} 项</summary><ul className={s.sources}>{input.sources.map(source => <li key={source.id}><SourceLink source={source} /><small>采集 {time(source.observedAt)}{source.publishedAt ? ` · 来源披露 ${source.publishedAt}` : " · 来源发布时间未提供"}</small></li>)}</ul></details>
  </>;
}

export function FundamentalPanel({ data }: { data: FundamentalPageData }) {
  const { state, entryAt } = data;
  const current = state?.current ?? null;
  const quote = state?.latestQuote ?? current?.input.quote ?? null;
  const historical = data.atEntry && entryAt && new Date(data.atEntry.publishedAt).getTime() <= new Date(entryAt).getTime() ? data.atEntry : null;
  return <section className={s.root} aria-label={`${data.symbol} 基本面目标价`}>
    {data.demo && <div className={s.demo} role="status"><strong>测试数据 · 非真实估值结果</strong><span>此页面用于演示布局与计算流程，价格、目标和解读均不能作为真实投资研究依据。</span></div>}
    <header className={s.header}><div><p className={s.eyebrow}>FUNDAMENTAL TARGET PRICE</p><h2 className={s.heading}>{data.symbol} · 基本面估值</h2></div><span className={s.status}>{data.error ? "读取暂不可用" : state ? labels[state.status] : "尚无估值留档"}</span></header>
    <p className={s.muted}>2H / 4H 共用此估值。仅提供基本面价值参考，不改变买卖信号、仓位与退出规则。</p>
    {entryAt && <div className={s.notice}><strong>历史时点核对 · {time(entryAt)}</strong>
      <p>{historical ? `已找到当时可知的版本（发布 ${time(historical.publishedAt)}）。` : "当时没有可用的估值留档，不能用最新目标价代替。"}
        下方主卡为最新留档，<a className={s.link} href="#entry-valuation">查看信号 / 模拟入场时的版本 ↓</a></p>
    </div>}
    {data.error && <p className={`${s.notice} ${s.warning}`} role="status">估值快照暂时无法读取，请稍后重试。不会影响现有信号。</p>}
    {state && state.status !== "ready" && <div className={`${s.notice} ${s.warning}`} role="status"><strong>{labels[state.status]}</strong>{current && <p>以下是上一版估值，不代表已完成本次更新。</p>}{state.reasons.length > 0 && <ul className={s.list}>{state.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>}</div>}
    {state?.status === "ready" && state.reasons.length > 0 && <div className={`${s.notice} ${s.warning}`} role="status"><strong>覆盖与核验提示</strong><ul className={s.list}>{state.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></div>}
    {state && <ValuationFacts state={state} />}
    {!current ? <p className={s.notice}>尚无可展示的基本面目标价。后台完成数据核验与估值后，这里会显示已保存结果。</p> : <>
      <div className={s.grid}><Horizon value={current.sixMonth} currency={current.input.currency} price={quote?.price ?? null} previous={false} reported={isReportedScenario(current)} /><Horizon value={current.twelveMonth} currency={current.input.currency} price={quote?.price ?? null} previous={false} reported={isReportedScenario(current)} /></div>
      <p className={s.muted}>{isReportedScenario(current) ? "每个期限按模型假设推导目标时点的年化盈利能力；参考窗口仅标记年化口径，不代表该时段实际盈利或未来现金流预测。" : "每个期限使用其目标日期之后 12 个月的盈利预测；不是到价时间承诺。"}价格空间相对上述留档报价计算；情景权重是预设权重，不是实证概率。</p>
      <InvestorReadout value={current} status={state!.analystStatus} />
      <p className={s.muted}>{state!.status === "ready" ? "当前留档版本" : "上一有效版本"} · 发布 <time dateTime={current.publishedAt}>{time(current.publishedAt)}</time></p>
      <ValuationDetail value={current} />
    </>}
    <details id="entry-valuation" className={s.details} open={Boolean(entryAt)}><summary>历史入场时已知的估值</summary>
      {!entryAt ? <p>未提供带时区的准确入场时间，无法判断当时已知的估值。当前目标价不能视为历史买点出现时已知。</p> : <><p>入场时间 <time dateTime={entryAt}>{time(entryAt)}</time></p>{historical ? <><p>入场前已发布版本 · {time(historical.publishedAt)}。本次展示该版本原始{isReportedScenario(historical) ? "年化能力参考窗口" : "盈利窗口"}和留档报价，不使用当前报价回填。</p><div className={s.grid}><Horizon value={historical.sixMonth} currency={historical.input.currency} price={historical.input.quote?.price ?? null} previous reported={isReportedScenario(historical)} /><Horizon value={historical.twelveMonth} currency={historical.input.currency} price={historical.input.quote?.price ?? null} previous reported={isReportedScenario(historical)} /></div><ValuationDetail value={historical} historical /></> : <p>该入场时间之前没有可读取的估值版本。未使用后续目标价补填。</p>}</>}
    </details>
    <details className={s.details}><summary>估值修订历史 · {data.history.length} 版</summary>
      {data.history.length === 0 ? <p>尚无修订记录。</p> : <ol className={s.history}>{data.history.map(value => <li key={value.id}><strong>{time(value.publishedAt)} · 12M {money(value.twelveMonth.weightedTarget, value.input.currency)}</strong>{value.revision ? <p>原目标 {money(value.revision.previousTarget, value.input.currency)} → 新目标 {money(value.revision.newTarget, value.input.currency)}（{percent(value.revision.changePct)}）<br />{value.revision.kind === "model-change" ? <>模型口径变更贡献 {money(value.revision.modelContribution, value.input.currency)}；两版方法不同，不解读为盈利预期修订。</> : <>盈利变化贡献 {money(value.revision.earningsContribution, value.input.currency)} · 倍数变化贡献 {money(value.revision.multipleContribution, value.input.currency)}</>}</p> : <p>首次估值留档</p>}<ul className={s.list}>{value.updateReasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></li>)}</ol>}
    </details>
    <p className={s.muted}>本页只读取保存结果；打开或刷新不会触发 AI 调用、采集或交易。</p>
  </section>;
}
