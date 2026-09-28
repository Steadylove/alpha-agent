"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
	Button,
	Drawer,
	Pagination,
	SegmentedControl,
	Select,
	TextInput,
} from "@mantine/core";
import { ArrowDownToLine, ArrowUpRight, Search } from "lucide-react";
import {
	CartesianGrid,
	Line,
	LineChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { PageHeading } from "@/components/PageHeading";
import { Disclosure } from "@/components/Disclosure";
import type {
	Profile,
	ResearchIndex,
	ResearchReport,
	SimTrade,
} from "@/lib/intraday/researchTypes";
import s from "./intraday.module.css";

const profiles: Record<Profile, string> = {
	"price-volume": "价格量能版",
	strict: "严格筛选版",
	"formula-only": "原始共振诊断",
};
const eventNames: Record<string, string> = {
	entry: "入场",
	partial: "减仓",
	exit: "退出",
	stop: "止损",
	watch: "观察",
};
const reasons: Record<string, string> = {
	premium_resonance: "优质共振",
	pivot_resonance: "能量共振",
	resonance_reduce: "共振减仓",
	resonance_top: "逃顶信号",
	stop_touch: "触及止损",
	session_end: "盘前结束",
	session_gap: "跨时段退出",
};
const num = (v: number | null | undefined, d = 2) =>
	v == null
		? "—"
		: v.toLocaleString("en-US", {
				minimumFractionDigits: d,
				maximumFractionDigits: d,
			});
const money = (v: number | null | undefined) =>
	v == null ? "—" : `${v < 0 ? "−" : ""}$${num(Math.abs(v))}`;
const pct = (v: number | null | undefined) => (v == null ? "—" : `${num(v)}%`);
const time = (t: number) =>
	new Intl.DateTimeFormat("sv-SE", {
		timeZone: "America/New_York",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(t) + " ET";
const metric = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) ? v : null;
const tone = (v: number) => (v > 0 ? s.up : v < 0 ? s.down : s.muted);
function Heading({
	n,
	title,
	note,
}: {
	n: string;
	title: string;
	note: string;
}) {
	return (
		<div className={s.heading}>
			<div>
				<span>{n}</span>
				<h2>{title}</h2>
			</div>
			<p>{note}</p>
		</div>
	);
}

export function IntradayResearch({
	report: r,
	runs,
	error,
}: {
	report: ResearchReport | null;
	runs: ResearchIndex["runs"];
	error: string | null;
}) {
	const router = useRouter(),
		[pending, start] = useTransition();
	const [scenario, setScenario] = useState("0"),
		[tab, setTab] = useState("trades"),
		[search, setSearch] = useState(""),
		[page, setPage] = useState(1),
		[detail, setDetail] = useState<SimTrade | null>(null);
	const sim = r?.scenarios[Number(scenario)] ?? r?.scenarios[0];
	const go = (id: string) => {
		setPage(1);
		setDetail(null);
		start(() => router.push(`/intraday?run=${encodeURIComponent(id)}`));
	};
	const filteredTrades = (sim?.trades ?? []).filter((t) =>
		t.symbol.includes(search.trim().toUpperCase()),
	);
	const filteredEvents = (r?.events ?? []).filter((e) =>
		e.payload.symbol.includes(search.trim().toUpperCase()),
	);
	const rows = tab === "trades" ? filteredTrades : filteredEvents;
	const visiblePage = Math.min(page, Math.max(1, Math.ceil(rows.length / 20))),
		startAt = (visiblePage - 1) * 20;
	const entryCount =
		r?.events.filter((e) => e.payload.event === "entry").length ?? 0;
	const download = (format: string) =>
		`/api/intraday/research?run=${r?.id}&format=${format}`;
	const funnel = r
		? ([
				["盘前有效分钟", r.funnel.sessionBars],
				["完成 500 根预热", r.funnel.warmed],
				["前 50 日参考可用", r.funnel.dailyReady],
				["价格 $1–20", r.funnel.price],
				["较昨收 ≥20%", r.funnel.gain],
				["累计量 / 日均量 ≥5", r.funnel.volume],
				...(r.profile === "strict"
					? [
							["历史 Float 已知", r.funnel.floatKnown],
							["Float <2000 万", r.funnel.float],
						]
					: []),
			] as [string, number][])
		: [];
	const outcomes = detail
		? (sim?.executions.filter((e) => e.tradeId === detail.id) ?? [])
		: [];
	return (
		<div className={s.root} aria-busy={pending}>
			<PageHeading
				eyebrow="INTRADAY LAB"
				title="日内策略研究"
				english="Intraday research"
				description="用真实行情检验盘前共振。先记录，再验证，最后才讨论执行。"
				action={
					<div className={s.status}>
						<i /> OFFLINE RESEARCH <span>模拟账户 · 独立存档</span>
					</div>
				}
			/>
			{error && (
				<div role="alert" className={s.notice}>
					{error}
				</div>
			)}
			{!r ? (
				<section className={s.empty}>
					<span>NO RUNS YET</span>
					<h2>等待第一份研究报告</h2>
					<p>
						完成历史补采与回放后，数据覆盖、模拟成绩和逐笔证据将在这里展示。
					</p>
					<Button
						variant="default"
						loading={pending}
						onClick={() => start(() => router.refresh())}
					>
						重新读取
					</Button>
				</section>
			) : (
				<>
					<div className={s.toolbar}>
						<Select
							label="研究版本"
							aria-label="研究版本"
							value={r.id}
							disabled={pending}
							searchable
							data={[
								...(!runs.some((x) => x.id === r.id)
									? [
											{
												value: r.id,
												label: `${profiles[r.profile]} · 已归档版本`,
											},
										]
									: []),
								...runs.map((x) => ({
									value: x.id,
									label: `${x.from.slice(5)}—${x.to.slice(5)} · ${profiles[x.profile]} · ${x.source === "tv" ? "TV" : "离线"} / ${x.precision === "quotes" ? "报价" : x.precision === "bars" ? "分钟" : "诊断"}`,
								})),
							]}
							onChange={(id) => {
								if (id) go(id);
							}}
							className={s.selector}
						/>
						<div className={s.downloads}>
							<Button
								component="a"
								href={download("csv")}
								variant="default"
								size="xs"
								leftSection={<ArrowDownToLine size={14} />}
							>
								逐笔 CSV
							</Button>
							<Button
								component="a"
								href={download("json")}
								variant="subtle"
								color="gray"
								size="xs"
							>
								完整 JSON
							</Button>
						</div>
					</div>
					<div className={s.meta}>
						<span>
							{r.from} — {r.to}
						</span>
						<span>{r.sessions.length} 个交易日</span>
						<span>Alpaca SIP · 1 分钟 + 日线</span>
						<span>04:00–09:30 ET</span>
						<span>
							{r.source === "tv" ? "TV 原始收件回放" : "本地历史计算"}
						</span>
					</div>
					<div className={s.read}>
						<span>RESEARCH NOTE</span>
						<div>
							<h2>
								{r.profile === "strict" && r.floatCoverage === 0
									? "历史 Float 尚缺，严格策略暂不能验证。"
									: r.profile === "formula-only"
										? "先检验信号本身，暂不计算账户收益。"
										: !sim?.trades.length
											? "当前筛选口径没有可模拟成交。"
											: `已生成 ${num(entryCount, 0)} 次入场信号，${num(sim?.trades.length, 0)} 笔进入模拟账户。`}
							</h2>
							<p>
								{r.profile === "price-volume"
									? "此版本保留价格、涨幅和量能门槛，未验证历史流通股本。当前股票池回看历史存在选池偏差，结果用于探索。"
									: "零交易和高收益都需结合数据覆盖与执行假设解读；本页不据此判断实盘可盈利。"}
							</p>
						</div>
					</div>
					<div className={s.coverage}>
						<div>
							<span>行情下载完成</span>
							<strong>
								{num(r.completed, 0)} <small>/ {num(r.universeCount, 0)}</small>
							</strong>
							<p>请求完成不等于逐分钟都有成交</p>
						</div>
						<div>
							<span>测试期有效 K 线</span>
							<strong>{num(r.barCount, 0)}</strong>
							<p>包含盘前、盘中和盘后</p>
						</div>
						<div>
							<span>盘前有记录的股票日</span>
							<strong>
								{num(r.symbolDays, 0)}{" "}
								<small>/ {num(r.sessions.length * r.universeCount, 0)}</small>
							</strong>
							<p>{num(r.missingSymbolDays, 0)} 个股票日无记录</p>
						</div>
						<div>
							<span>历史 Float 覆盖</span>
							<strong className={r.floatCoverage ? s.up : s.gold}>
								{num(r.floatCoverage, 0)}{" "}
								<small>/ {num(r.universeCount, 0)}</small>
							</strong>
							<p>缺失值不使用当前股本填补</p>
						</div>
					</div>
					<Heading
						n="01 / PERFORMANCE"
						title="模拟账户"
						note="资金曲线是情景估计，不是券商实盘记录"
					/>
					{sim ? (
						<>
							<div className={s.scenarios}>
								<SegmentedControl
									aria-label="成本情景"
									value={scenario}
									onChange={(v) => {
										setScenario(v);
										setDetail(null);
										setPage(1);
									}}
									data={r.scenarios.map((x, i) => ({
										value: String(i),
										label: x.label,
									}))}
								/>
								<span>
									本金 {money(sim.initialCash)} ·{" "}
									{sim.precision === "quotes"
										? "买卖报价成交估计"
										: "分钟开盘成交近似"}
								</span>
							</div>
							<div className={s.metrics}>
								<div>
									<span>账户净变化</span>
									<strong className={tone(sim.net)}>{money(sim.net)}</strong>
									<p>{pct(sim.returnPct)} · 含未平仓估值</p>
								</div>
								<div>
									<span>最大观察回撤</span>
									<strong>{pct(sim.maxDrawdownPct)}</strong>
									<p>仅可见价格路径，非最坏损失上限</p>
								</div>
								<div>
									<span>已平仓胜率</span>
									<strong>{pct(sim.winRate)}</strong>
									<p>
										{sim.wins} 赢 / {sim.closed} 已平仓 · {sim.open} 未平仓
									</p>
								</div>
								<div>
									<span>每笔平均净收益</span>
									<strong className={tone(sim.expectancy ?? 0)}>
										{money(sim.expectancy)}
									</strong>
									<p>已平仓样本 · 总手续费 {money(sim.fees)}</p>
								</div>
							</div>
							<div className={s.chartPanel}>
								<div className={s.chartTitle}>
									<span>ACCOUNT EQUITY / USD</span>
									<p>完整交易日 · 空仓日期保留</p>
								</div>
								<div
									className={s.chart}
									role="img"
									aria-label="每日模拟账户权益曲线"
								>
									<ResponsiveContainer width="100%" height="100%">
										<LineChart
											data={[
												{ date: "起始", equity: sim.initialCash },
												...sim.days,
											]}
											margin={{ top: 12, right: 16, left: 2, bottom: 2 }}
										>
											<CartesianGrid
												vertical={false}
												stroke="var(--border-subtle)"
											/>
											<XAxis
												dataKey="date"
												tickFormatter={(v) => (v === "起始" ? v : v.slice(5))}
												tick={{ fill: "var(--text-muted)", fontSize: 11 }}
												minTickGap={40}
												tickLine={false}
												axisLine={false}
											/>
											<YAxis
												tick={{ fill: "var(--text-muted)", fontSize: 11 }}
												width={70}
												tickLine={false}
												axisLine={false}
												domain={["auto", "auto"]}
												tickFormatter={(v) => num(v, 0)}
											/>
											<Tooltip
												contentStyle={{
													background: "var(--surface-raised)",
													border: "1px solid var(--border-strong)",
													fontSize: 12,
												}}
												formatter={(v) => [money(Number(v)), "账户权益"]}
											/>
											<Line
												type="linear"
												dataKey="equity"
												stroke="var(--accent)"
												strokeWidth={2}
												dot={false}
												isAnimationActive={false}
											/>
										</LineChart>
									</ResponsiveContainer>
								</div>
								<div className={s.chartFoot}>
									<span>最长连续亏损：{sim.consecutiveLosses} 笔</span>
									<span>平均盈利：{money(sim.averageWin)}</span>
									<span>平均亏损：{money(sim.averageLoss)}</span>
									<span>利润因子：{num(sim.profitFactor)}</span>
								</div>
							</div>
						</>
					) : (
						<p className={s.notice}>
							原始共振仅供公式诊断，没有应用账户规则，因此不显示收益率。
						</p>
					)}
					<div className={s.split}>
						<section className={s.panel}>
							<Heading
								n="02 / SELECTION"
								title="信号从哪里来"
								note="筛选单位为分钟，不是股票数"
							/>
							{funnel.map(([label, value], i) => (
								<div className={s.funnel} key={label}>
									<div>
										<span>{label}</span>
										<b>{num(value, 0)}</b>
									</div>
									<div className={s.track}>
										<i
											style={{
												width: `${funnel[0][1] ? Math.max(value ? 1 : 0, (value / funnel[0][1]) * 100) : 0}%`,
												opacity: 1 - i * 0.075,
											}}
										/>
									</div>
								</div>
							))}
							<div className={s.signalCounts}>
								<span>
									预热后原始共振 <b>{num(r.funnel.resonance, 0)}</b>
								</span>
								<span>
									与本口径筛选同时成立 <b>{num(r.funnel.eligible, 0)}</b>
								</span>
								<span>
									信号模型入场 <b>{num(r.funnel.entries, 0)}</b>
								</span>
							</div>
							<p className={s.explain}>
								{r.profile === "formula-only"
									? "此处列出价格量能筛选的诊断计数；原始共振报告没有使用这些过滤条件。"
									: "先应用固定筛选，再等待三根内共振；已有模型持仓时不重复入场。"}
								{r.source === "tv"
									? "漏斗来自离线计算；TV 入场数量以原始档案为准。"
									: ""}
							</p>
						</section>
						<section className={s.panel}>
							<Heading
								n="03 / EVIDENCE"
								title="数据与执行边界"
								note="无法验证的部分明确保留"
							/>
							<ul className={s.warnings}>
								{r.warnings.map((w) => (
									<li key={w}>{w}</li>
								))}
							</ul>
							<div className={s.tv}>
								<span>TRADINGVIEW / ARCHIVE FIRST</span>
								<h3>同一个信号协议，两套独立证据。</h3>
								<p>
									已预留 TV Webhook
									存档接口与原始收件回放。此页只读取研究报告；没有接收记录时，不显示为“已连接”。
								</p>
								<p>
									当前来源：
									<b>
										{r.source === "tv"
											? "已导入 TV 档案"
											: "离线计算，尚未导入 TV 档案"}
									</b>
								</p>
							</div>
						</section>
					</div>
					<Heading
						n="04 / JOURNAL"
						title="逐笔验证"
						note="信号价与模拟成交价分别保存"
					/>
					<div className={s.tableTools}>
						<SegmentedControl
							value={tab}
							onChange={(v) => {
								setTab(v);
								setPage(1);
							}}
							data={[
								{
									value: "trades",
									label: `模拟交易 · ${sim?.trades.length ?? 0}`,
								},
								{
									value: "events",
									label: `信号档案 · ${num(r.signalCount, 0)}`,
								},
							]}
						/>
						<TextInput
							aria-label="搜索股票"
							placeholder="搜索股票，如 NASDAQ:..."
							value={search}
							onChange={(e) => {
								setSearch(e.currentTarget.value);
								setPage(1);
							}}
							leftSection={<Search size={15} />}
						/>
					</div>
					<div className={s.tableWrap}>
						<table>
							<thead>
								{tab === "trades" ? (
									<tr>
										<th>股票 / 共振类型</th>
										<th>入场时间 ET</th>
										<th>成交价</th>
										<th>数量</th>
										<th>已实现净额</th>
										<th>状态</th>
										<th>证据</th>
									</tr>
								) : (
									<tr>
										<th>股票</th>
										<th>信号时间 ET</th>
										<th>事件</th>
										<th>原因</th>
										<th>信号价</th>
										<th>止损参考</th>
									</tr>
								)}
							</thead>
							<tbody>
								{tab === "trades"
									? filteredTrades.slice(startAt, startAt + 20).map((t) => (
											<tr key={t.id}>
												<td>
													<b>{t.symbol}</b>
													<small>{reasons[t.kind] ?? t.kind}</small>
												</td>
												<td>{time(t.entryTime).replace(" ET", "")}</td>
												<td>${num(t.entry, 4)}</td>
												<td>{t.qty}</td>
												<td className={tone(t.net)}>{money(t.net)}</td>
												<td>
													{t.status === "closed"
														? "已平仓"
														: `待平 ${t.remaining} 股`}
												</td>
												<td>
													<Button
														variant="subtle"
														size="compact-xs"
														onClick={() => setDetail(t)}
														rightSection={<ArrowUpRight size={13} />}
													>
														查看
													</Button>
												</td>
											</tr>
										))
									: filteredEvents.slice(startAt, startAt + 20).map((e) => (
											<tr key={e.id}>
												<td>
													<b>{e.payload.symbol}</b>
												</td>
												<td>{time(e.payload.signalTime).replace(" ET", "")}</td>
												<td>{eventNames[e.payload.event]}</td>
												<td>{reasons[e.payload.reason] ?? e.payload.reason}</td>
												<td>${num(e.payload.price, 4)}</td>
												<td>${num(e.payload.stop, 4)}</td>
											</tr>
										))}
							</tbody>
						</table>
						{!rows.length && (
							<p className={s.noRows}>
								{search
									? "没有匹配的股票。"
									: tab === "trades"
										? "本报告没有模拟成交；请结合信号档案和筛选漏斗查看原因。"
										: "本口径没有产生信号。"}
							</p>
						)}
					</div>
					<div className={s.pagination}>
						<p>
							{tab === "events" && r.events.length < r.signalCount
								? `页面载入前 ${r.events.length} 条；完整记录请下载 JSON。`
								: `共 ${num(rows.length, 0)} 条 · 每页 20 条`}
						</p>
						<Pagination
							size="sm"
							value={visiblePage}
							onChange={setPage}
							total={Math.max(1, Math.ceil(rows.length / 20))}
						/>
					</div>
					<Disclosure title="计算规则、执行限制与数据清单">
						<div className={s.methods}>
							<h3>固定规则</h3>
							<p>
								1 分钟常规 K 线，连续使用 04:00–20:00 ET 行情计算指标，盘前
								04:00–09:30 ET 观察买点。27 周期位置三次 RMA 平滑，结合 WR34 /
								WR14 状态，三根内共振；买入冷却 4 根。无新闻核验。
							</p>
							<p>
								单笔风险预算 0.25%，单仓名义上限 20%，最多 2
								仓；每日账户亏损达到 1%
								后停止新开仓。风险预算不是最大损失承诺。仅使用已结算现金，卖出资金按下个提供的交易日解冻；特殊结算假日尚未核验。
							</p>
							<p>
								入场信号收盘确认后，加 2 秒延迟（压力情景 5
								秒）；分钟版再取整到下一分钟开盘。报价版用当时买卖报价、1%
								最大开仓价差和限价保护，不使用信号收盘价假定成交。单次不超过最近完成分钟成交量的
								1%，报价版同时限制可见数量。减仓信号目标
								50%，退出未成交可继续排队。
							</p>
							<p>
								保护止损来自信号时最近 8
								根最低价，历史回放按完整分钟确认后排队退出；没有模拟逐笔首触止损。基础每股费用
								$0.005、每次至少 $1，另计至少 $0.01 或 0.1% 滑点；均为研究假设。
							</p>
							{sim && (
								<>
									<h3>当前执行边界</h3>
									<ul>
										{sim.warnings.map((w) => (
											<li key={w}>{w}</li>
										))}
									</ul>
									<h3>未执行 / 被过滤的尝试</h3>
									<div className={s.attempts}>
										{Object.entries(sim.rejected).map(([k, v]) => (
											<div key={k}>
												<code>{k}</code>
												<b>{num(v, 0)}</b>
											</div>
										))}
									</div>
								</>
							)}
							<h3>数据清单</h3>
							<p>
								标的日无记录可能代表无成交，不补造
								OHLC；检测到拆并股线索的股票在核验前跳过。{r.warmupInsufficient}{" "}
								只股票在起点预热不足。
							</p>
							<div className={s.tableWrap}>
								<table>
									<thead>
										<tr>
											<th>股票</th>
											<th>测试期 K 线</th>
											<th>盘前有记录的天数</th>
											<th>信号</th>
											<th>说明</th>
										</tr>
									</thead>
									<tbody>
										{r.diagnostics
											.filter(
												(d) => d.issue || d.sessionDays < r.sessions.length,
											)
											.map((d) => (
												<tr key={d.symbol}>
													<td>{d.symbol}</td>
													<td>{d.bars}</td>
													<td>{d.sessionDays}</td>
													<td>{d.signals}</td>
													<td>{d.issue ?? "部分日期没有盘前有效成交记录"}</td>
												</tr>
											))}
									</tbody>
								</table>
							</div>
							<p className={s.hash}>
								数据集 {r.dataId}
								<br />
								源码校验 {r.sourceHash}
								<br />
								股票池校验 {r.universeHash}
								<br />
								报告生成 {time(Date.parse(r.builtAt))}
							</p>
						</div>
					</Disclosure>
					<footer className={s.footer}>
						<span>TREND ADAPTIVE / RESEARCH</span>
						<p>仅供信息参考，不构成投资建议</p>
					</footer>
				</>
			)}
			<Drawer
				opened={!!detail}
				onClose={() => setDetail(null)}
				title={detail ? `${detail.symbol} · 模拟交易证据` : "交易证据"}
				position="right"
				size="lg"
			>
				{detail && (
					<div className={s.detail}>
						<p>
							参考止损 ${num(detail.stop, 4)} · 初始名义风险{" "}
							{money(detail.risk)}
						</p>
						<p>
							已实现净额 {money(detail.net)} · MFE {pct(detail.mfe)} / MAE{" "}
							{pct(detail.mae)}（可见整根分钟近似）
						</p>
						<h3>模拟执行</h3>
						{outcomes.map((e) => (
							<div key={e.id}>
								<b>
									{e.side === "buy" ? "买入" : "卖出"} {e.qty} 股 · $
									{num(e.price, 4)}
								</b>
								<p>
									{time(e.time)} · 费用 {money(e.fee)} ·{" "}
									{reasons[e.reason] ?? e.reason}
								</p>
							</div>
						))}
						<h3>对应原始信号</h3>
						{r?.events
							.filter((e) => e.tradeId === detail.id)
							.map((e) => (
								<div key={e.id}>
									<b>
										{eventNames[e.payload.event]} ·{" "}
										{reasons[e.payload.reason] ?? e.payload.reason}
									</b>
									<p>
										{time(e.payload.signalTime)} · 信号价 $
										{num(e.payload.price, 4)}
									</p>
									<p>
										涨幅 {pct(metric(e.payload.metrics.gainPct))} · 量比{" "}
										{num(metric(e.payload.metrics.rvol))} · TREND{" "}
										{num(metric(e.payload.metrics.trend))}
									</p>
								</div>
							))}
					</div>
				)}
			</Drawer>
		</div>
	);
}
