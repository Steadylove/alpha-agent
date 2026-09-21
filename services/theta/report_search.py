"""Complete, reproducible E03 research report; never selects a new strategy."""
from collections import Counter, defaultdict
from datetime import date
import json
import os
from pathlib import Path

os.environ.setdefault('MPLCONFIGDIR',str(Path(__file__).resolve().parents[2]/'.cache/matplotlib'))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

from forecast import write_json
from method_lock import ROOT
from pde_search_data import OUT, register

LABELS={'primary_quality_gated':'主方案：预测质量门槛＋全部组合',
        'ungated_research_ablation':'对照：去掉预测质量门槛',
        'neutral_only_quality_gated':'对照：质量门槛＋仅区间组合'}
ENGLISH=['Quality gate + all structures','No quality gate (ablation)','Quality gate + range structures']


def bootstrap(values,cfg):
    """Circular moving blocks preserve nearby days, not all market dependence."""
    x=np.asarray(values,float);n=len(x)
    if not n:
        return None
    b=cfg['block_sessions'];rng=np.random.default_rng(cfg['seed'])
    starts=rng.integers(n,size=(cfg['replicates'],int(np.ceil(n/b))))
    indices=((starts[:,:,None]+np.arange(b))%n).reshape(cfg['replicates'],-1)[:,:n]
    totals=x[indices].sum(axis=1)
    low,high=np.quantile(totals,[.025,.975])
    return {'sessions':n,'observed_sum':float(x.sum()),'observed_daily_mean':float(x.mean()),
            'sum_95_percentile_interval':[float(low),float(high)],
            'daily_mean_95_percentile_interval':[float(low/n),float(high/n)],
            'block_sessions':b,'replicates':len(totals)}


def money(value):
    return '—' if value is None else ('−' if value<0 else '')+f'${abs(value):,.2f}'


def pct(value):
    return '—' if value is None else f'{value:.1%}'


def table(results):
    lines=['|方案|笔数|胜率|净收益|结算口径最大回撤|额外滑点压力后收益|',
           '|---|---:|---:|---:|---:|---:|']
    for key,output in results.items():
        s=output['summary']
        lines.append(f"|{LABELS[key]}|{s['trades']}|{pct(s['win_rate'])}|{money(s['net_pnl_usd'])}|{money(s['settled_max_drawdown_usd'])}|{money(s['stress_pnl_usd'])}|")
    return lines


def analysis(result,registered):
    cfg=result['plan'];b=cfg['evaluation']['bootstrap']
    daily=json.loads(Path(registered['daily_source']).read_text())['rows']
    first=min((r['date'] for r in result['forecasts'] if r.get('quality')),default=cfg['last_decision_date'])
    output={'first_model_selection_date':first,'bootstrap':{},'paired_distribution_bootstrap':{},'edge_decomposition':{}}
    for scope in ('whole','evaluation'):
        start=max(first,cfg['evaluation']['evaluation_start']) if scope=='evaluation' else first
        days=[r['date'] for r in daily if start<=r['date']<=cfg['last_settlement_date']]
        output['bootstrap'][scope]={}
        for key,policy in result['policies'][scope].items():
            values=defaultdict(float)
            for trade in policy['trades']:
                values[trade['expiration']]+=trade['net_pnl_usd']
            output['bootstrap'][scope][key]=bootstrap([values[d] for d in days],b)
        rows=[r for r in result['forecasts'] if r['status']=='forecast' and (scope=='whole' or r['date']>=cfg['evaluation']['evaluation_start'])]
        output['paired_distribution_bootstrap'][scope]={}
        for name in cfg['probability_models']:
            values=defaultdict(list)
            for row in rows:
                values[row['date']].append(row['scores'][name]['crps']-row['scores']['Q_market']['crps'])
            output['paired_distribution_bootstrap'][scope][name]=bootstrap([float(np.mean(v)) for d,v in sorted(values.items())],b)
        output['edge_decomposition'][scope]={}
        for key,policy in result['policies'][scope].items():
            t=policy['trades'];average=lambda vals:float(np.mean(vals)) if vals else None
            output['edge_decomposition'][scope][key]={
                'mean_predicted_p_minus_q_payoff':average([r['p_minus_q_expected_payoff_usd'][r['probability_model']] for r in t]),
                'mean_q_mid_repricing_residual':average([r['q_mid_repricing_residual_usd'] for r in t]),
                'mean_spread_cost':average([r['natural_minus_mid_usd'] for r in t]),
                'mean_fees_and_extra_slippage':average([r['opening_fees_usd']+r['extra_slippage_usd'] for r in t]),
                'mean_predicted_net_EV':average([r['ev'][r['probability_model']] for r in t]),
                'mean_realized_net_pnl':average([r['net_pnl_usd'] for r in t])}
    output['refusal_reasons']=dict(Counter(r['reason'] for r in result['refusals']))
    output['distribution_by_time_expiry']={}
    for stamp in cfg['entry_times_et']:
        for offset in cfg['expiry_session_offsets']:
            rows=[r for r in result['forecasts'] if r['status']=='forecast' and r['time']==stamp and r['offset']==offset]
            output['distribution_by_time_expiry'][f'{stamp}/{offset}']={'forecasts':len(rows),
                'mean_crps':{name:float(np.mean([r['scores'][name]['crps'] for r in rows])) if rows else None
                             for name in ['Q_market',*cfg['probability_models']]}}
    # Same calendar window and same $2-per-contract stress as the current base case.
    old_path=ROOT/'data/thetadata/condor68-recheck/results.json'
    if old_path.exists():
        baseline=json.loads(old_path.read_text())
        rows=[r for r in baseline['trades'] if cfg['evaluation']['evaluation_start']<=r['date']<=cfg['last_decision_date']]
        pnls=np.array([r['stress_pnl_usd'] for r in rows]);curve=np.r_[0,np.cumsum(pnls)]
        output['fixed68_calendar_comparison']={'start':cfg['evaluation']['evaluation_start'],'end':cfg['last_decision_date'],
            'trades':len(rows),'net_pnl_usd':float(pnls.sum()),'win_rate':float(np.mean(pnls>0)),
            'settled_max_drawdown_usd':float(np.max(np.maximum.accumulate(curve)-curve)),
            'note':'Old Q0 68% daily 10:00 0DTE 10-point-wing condor; same calendar and costs, not matched trades or exposure.'}
    return output


def plot(result):
    colors=['#146b8d','#b37622','#7b4ca0']
    fig,axes=plt.subplots(2,1,figsize=(12,8),sharex=True,gridspec_kw={'height_ratios':[2,1]})
    fig.patch.set_facecolor('#f8fafc')
    first_quality=min((r['date'] for r in result['forecasts'] if r.get('quality')),default=result['plan']['last_decision_date'])
    for (key,policy),label,color in zip(result['policies']['whole'].items(),ENGLISH,colors):
        values=defaultdict(float)
        for t in policy['trades']:
            values[t['expiration']]+=t['net_pnl_usd']
        days=[result['plan']['input_start'],*sorted(values)]
        pnl=np.r_[0,np.cumsum([values[d] for d in sorted(values)])]
        dates=[date.fromisoformat(d) for d in days]
        axes[0].step(dates,pnl,where='post',label=label,color=color,lw=1.7)
        axes[1].step(dates,pnl-np.maximum.accumulate(pnl),where='post',color=color,lw=1.3)
    for ax in axes:
        ax.axvspan(date.fromisoformat(result['plan']['input_start']),date.fromisoformat(first_quality),color='#94a3b8',alpha=.10)
        ax.axvline(date.fromisoformat(result['plan']['evaluation']['evaluation_start']),color='#94a3b8',ls='--',lw=1)
        ax.axhline(0,color='#94a3b8',lw=.8);ax.grid(alpha=.15)
        ax.spines[['top','right']].set_visible(False)
        ax.tick_params(axis='x',rotation=20)
    axes[0].set_title('PDE-E03 | Historical research, one position at a time',loc='left',fontweight='bold')
    axes[0].set_ylabel('Cumulative net P&L (USD)');axes[0].legend(loc='best',fontsize=9)
    axes[1].set_ylabel('Settled drawdown (USD)')
    fig.text(.08,.01,'Bid/ask + USD 1.50 fee + USD 2 extra slippage per contract. Cash-close settlement proxy.\nShaded: training/validation warmup. Dashed: chronological split. Historical outcomes were already inspected.',fontsize=9,color='#475569')
    fig.tight_layout(rect=(0,.04,1,1));fig.savefig(OUT/'comparison.png',dpi=180);plt.close(fig)


def report():
    cfg,registered=register()
    result=json.loads((OUT/'results.json').read_text());audit=json.loads((OUT/'audit.json').read_text())
    assert audit['all_passed']
    stats=analysis(result,registered);write_json(OUT/'statistical-summary.json',stats)
    plot(result)
    totals=result['totals'];primary=result['policies']['whole']['primary_quality_gated']['summary']
    late=result['policies']['evaluation']['primary_quality_gated']['summary']
    header=['# PDE-E03：概率密度优势策略历史研究结果','',
        '数据范围 2025-09-16 至 2026-09-15，前段用于训练与验证预热，实际模拟交易从 2026 年 1 月开始。每次一组、最多一个持仓，按买 ask／卖 bid 加每张 $1.50 费用和 $2 额外滑点计算。','',
        f"主方案共 {primary['trades']} 笔，净收益 **{money(primary['net_pnl_usd'])}**，结算口径最大回撤 **{money(primary['settled_max_drawdown_usd'])}**。",
        f"2026-06-01 起的后段共 {late['trades']} 笔，净收益 **{money(late['net_pnl_usd'])}**，该段结算口径最大回撤 **{money(late['settled_max_drawdown_usd'])}**。",'',
        '**这是一轮完整历史研究，并没有证明稳定盈利。** 旧现金行情在本轮登记前已被查看，后段只是按时间切分的研究评估，不能称为未见过的独立测试。当前真实前瞻验证为 0 个交易日。','',
        '## 全部历史成绩','',*table(result['policies']['whole']),'',
        '## 2026-06-01 起的后段成绩','',*table(result['policies']['evaluation']),'']
    earlier_range=result['policies']['development']['neutral_only_quality_gated']['summary']
    later_range=result['policies']['evaluation']['neutral_only_quality_gated']['summary']
    edge=stats['edge_decomposition']['whole']['primary_quality_gated']
    header+=['## 这轮结果说明什么','',
        '- 三个预先登记方案在全部交易期扣除成本后都亏损，当前版本没有建立持续盈利的证据。',
        f"- 主方案模型平均预计每笔盈利 {money(edge['mean_predicted_net_EV'])}，历史实际平均为 {money(edge['mean_realized_net_pnl'])}。整体分布评分也未显示 P 模型优于市场隐含分布；有正的估算 EV 并不表示真实 EV 已被证实。",
        f"- 主方案最长连续亏损 {primary['longest_losing_streak_trades']} 笔，结算回撤 {money(primary['settled_max_drawdown_usd'])}。逐笔最大风险上限不能限制连续交易累计回撤。",
        f"- 仅区间组合的后段盈利 {money(later_range['net_pnl_usd'])}，但此前亏损 {money(earlier_range['net_pnl_usd'])}；结果对时期敏感，不能依据后段成绩就升级为已验证的主策略。",
        '- 区间组合最后实际选中了买入蝶式、铁蝶和不等翼蝶式；铁秃鹰参加了候选搜索，但最终没有被选中开仓。','']
    lines=[*header,'金额均为美元；每次一组、最多一个持仓，不复利、不叠加杠杆。区间组合对照包含蝶式、铁蝶、铁秃鹰及不等翼蝶式，不代表严格 Delta 中性。','',
        '## 样本和执行口径','',
        f"- 原始输入 {cfg['input_start']} 至 {cfg['last_decision_date']}，最后到期日 {cfg['last_settlement_date']}；{totals['requested_quote_jobs']} 组日期/到期日行情。",
        f"- 可用快照 {totals['prepared_snapshots']}，拒绝 {totals['refused_snapshots']}；训练暖机 {totals['warmup_snapshots']}，评分预测 {totals['scored_forecasts']}，成本后候选 {totals['priced_candidates']}。同日不同时间/到期日相互相关，不能当作独立交易。",
        f"- 首个完成模型选择暖机的日期 {stats['first_model_selection_date']}；按时间和到期日分别使用过去 60–120 个已到期样本训练、20–40 个已成熟预测选择模型。",
        '- 美东 10:00、11:00、14:00 依次检查当日/下一交易日到期组合，第一次合格才入场；不事后挑当天最佳时点。原持仓到期当天仍占仓。',
        '- 买入用 ask、卖出用 bid，并核对相应档位数量；每张手续费 $1.50，额外不利滑点 $2，压力情景为 $5。快照并不保证多腿可以同时成交。',
        '- 每笔基础情景最大损失不超过 $1,000，预计净利润至少 $10 且不少于最大风险的 2%。这只是模型估计和逐笔上限，累计亏损可能远高于 $1,000。',
        '- 持有完整组合至现金到期，以 SPX 日收盘作为结算代理。没有盘中止盈止损，也没有逐时盯市回撤；实际账户回撤可能更大。手续费为统一研究假设，非逐笔券商账单。',
        '- 未另扣数据订阅、税费、融资或其他账户收费，也未计闲置现金利息；这些结果不是实际账户报表。',
        '- 期限、结构、报价限制、风险限制和评分规则先登记，观察 E03 盈亏后不再调参。本轮不报告年化收益或账户收益率。','',
        '## PDF 思想如何落实','',
        'P 是利用历史数据估计的未来价格分布，仍需要验证；Q 是从期权报价反推的市场隐含定价分布，不等于现实发生概率。','',
        '|PDF 思想|当前实现|','|---|---|',
        '|完整分布而非单一区间|拟合市场 Q 密度；P_normal、历史残差 P_kernel，以及 IV/RV＋偏斜状态加权 P_state|',
        '|P 与 Q 的差异必须转化为可成交优势|逐腿积分 payoff，拆分 P−Q、Q 拟合残差、买卖价差、手续费和滑点；Q 下成本后已正收益的候选拒绝作为信号|',
        '|先验证分布质量|仅使用过去已成熟预测的 CRPS（整体概率分布误差，越低越好）选模型，主方案还要求优于 Q|',
        '|联合搜索但控制自由度|9 类结构、固定行权价网格、3 个时间、2 个到期日，按预计净收益/最大风险选一组，允许空仓|',
        '|先做可证伪验证|固定参数、滚动训练、成本压力、时间穿越测试、现金流复算、完整月度成绩和对照|',
        '|尚未实现的可选扩展|未用不可观测的真实做市商仓位构造 GEX；未加资金流、深度学习、盘中调整、滚仓或实盘执行|','',
        '这里的“PDE”按文档的概率密度优势流程实现；没有凭名字就引入偏微分方程，也没有将期权隐含分布直接称为真实概率。','',
        '## 分布质量：是否真的比市场更好','',
        '|模型|全部评分 CRPS|68% 覆盖率|68% 平均宽度（点）|95% 覆盖率|后段 CRPS|',
        '|---|---:|---:|---:|---:|---:|']
    for name,s in result['distribution_scores']['whole'].items():
        e=result['distribution_scores']['evaluation'][name]
        scored=[r for r in result['forecasts'] if r['status']=='forecast']
        width=float(np.mean([r['scores'][name]['bands']['68']['high']-r['scores'][name]['bands']['68']['low'] for r in scored]))
        lines.append(f"|{name}|{s['mean_crps']:.4f}|{pct(s['coverage']['68'])}|{width:.2f}|{pct(s['coverage']['95'])}|{e['mean_crps']:.4f}|")
    lines+=['','按日期先平均同日预测，再做 5 个交易日分块重采样；以下 P−Q 的 CRPS 差值小于 0 才有利于 P。区间不是未来保证，也没有消除本轮反复研究同一段历史的偏差。','',
        '|模型|每日平均 CRPS 差|95% 分块重采样区间|','|---|---:|---|']
    for name,s in stats['paired_distribution_bootstrap']['whole'].items():
        low,high=s['daily_mean_95_percentile_interval']
        lines.append(f"|{name}|{s['observed_daily_mean']:+.4f}|[{low:+.4f}, {high:+.4f}]|")
    lines+=['','## 收益不确定性','',
        '对完成暖机后的每个交易日计入结算损益（空仓日为 0），按 5 日分块、2,000 次重采样。该方法保留短期依赖，但无法代表未出现的极端行情。后段按入场日期归属，组合在分界处连续运行。','',
        '|方案|全部时期总利润重采样 95% 区间|后段总利润重采样 95% 区间|','|---|---|---|']
    for key in LABELS:
        intervals=[]
        for scope in ('whole','evaluation'):
            v=stats['bootstrap'][scope][key]['sum_95_percentile_interval']
            intervals.append(f'[{money(v[0])}, {money(v[1])}]')
        lines.append(f"|{LABELS[key]}|{'|'.join(intervals)}|")
    lines+=['','## 逐月成绩','',
        '按开仓月份归属；跨月到期收益归入开仓月。这里只是固定一组交易的美元盈亏，并非账户月收益率。','',
        '|月份|主方案笔数|主方案净收益|无质量门槛净收益|仅区间组合净收益|','|---|---:|---:|---:|---:|']
    month_maps={key:{m['month']:m for m in p['monthly']} for key,p in result['policies']['whole'].items()}
    for month,m in month_maps['primary_quality_gated'].items():
        lines.append(f"|{month}|{m['trades']}|{money(m['net_pnl_usd'])}|{money(month_maps['ungated_research_ablation'][month]['net_pnl_usd'])}|{money(month_maps['neutral_only_quality_gated'][month]['net_pnl_usd'])}|")
    lines+=['','## 主方案收益来自哪里','',
        f"- 平均盈利：{money(primary['mean_win_usd'])}；平均亏损：{money(primary['mean_loss_usd'])}；最差一笔：{money(primary['worst_trade_usd'])}。",
        f"- 最长连续亏损 {primary['longest_losing_streak_trades']} 笔。单笔风险有限并不限制连续交易的累计回撤。",
        f"- 结构笔数：`{json.dumps(primary['families'],ensure_ascii=False)}`。",
        f"- 到期日偏移（0 为当日、1 为下一交易日）：`{json.dumps(primary['expiry_offsets'])}`。",
        f"- 入场时间：`{json.dumps(primary['entry_times'])}`。",
        f"- 入场所用 P 模型：`{json.dumps(primary['models'])}`。",'',
        '|平均每笔分解|金额|','|---|---:|']
    names={'mean_predicted_p_minus_q_payoff':'预测 P−Q payoff 优势','mean_q_mid_repricing_residual':'Q 相对中间价的拟合残差',
        'mean_spread_cost':'自然成交价相对中间价成本','mean_fees_and_extra_slippage':'手续费＋额外滑点',
        'mean_predicted_net_EV':'模型预测净期望收益','mean_realized_net_pnl':'历史实际结算代理收益'}
    for key,value in stats['edge_decomposition']['whole']['primary_quality_gated'].items():
        lines.append(f'|{names[key]}|{money(value)}|')
    lines+=['','|方案|每笔模型预测盈利概率的平均值|历史实际胜率|','|---|---:|---:|']
    for key,policy in result['policies']['whole'].items():
        probability=float(np.mean([t['metrics']['p_profit'] for t in policy['trades']])) if policy['trades'] else None
        lines.append(f"|{LABELS[key]}|{pct(probability)}|{pct(policy['summary']['win_rate'])}|")
    lines+=['','预测概率来自待验证的 P 模型，不是事先已知的真实胜率。按 EV/最大风险排序会偏好某些低成本、低胜率、高赔率结构；这轮没有把高胜率作为选仓目标。']
    if (old:=stats.get('fixed68_calendar_comparison')):
        lines+=['','## 与原固定 68% 铁秃鹰的同日历窗口比较','',
                f"在 {old['start']} 至 {old['end']}，旧规则共 {old['trades']} 笔，净收益 {money(old['net_pnl_usd'])}，胜率 {pct(old['win_rate'])}，结算口径最大回撤 {money(old['settled_max_drawdown_usd'])}。",'',
                '旧规则为每日 10:00、Q0 的 68% 区间、10 点保护翼、当日到期。这里已统一为每张 $1.50 费用＋$2 额外滑点。日历和成本一致，但 E03 可空仓、换结构/时点/到期日，持仓暴露不同，不能将差值都归因于概率模型改进。']
    lines+=['','## 空仓和数据拒绝','',
        f"主方案 NO_TRADE 检查时点原因：`{json.dumps(dict(Counter(r['reason'] for r in result['policies']['whole']['primary_quality_gated']['decisions'] if r['action']=='NO_TRADE')),ensure_ascii=False)}`。这些是时点数量，同一天可能多次检查。",'',
        f"数据拒绝原因：`{json.dumps(stats['refusal_reasons'],ensure_ascii=False)}`。",'',
        '## 解释边界和下一步','',
        '- 市场 Q 是符合报价区间的有限网格拟合，解不唯一；尾部有限、短期期权贴现系数近似为 1。即使模型认为 EV 为正，也可能来自 P 错估或 Q 拟合选择。',
        '- 三种政策是事前列出的研究对照，不能看完结果就把最赚钱的一条升级成已验证主策略；同理，局部盈利月份不能证明长期月赚 5%。',
        '- 只有事后收益为正、分布误差却没有改善时，应保留“方向暴露/运气/样本依赖”的解释；不能直接说找到了密度优势。',
        '- 下一步只应冻结规则做新的逐日前瞻纸上记录，保存信号时间、可成交报价、实际价差、拒绝理由及完整损益，再决定是否值得继续。',
        '- 若模型质量门槛长期不能通过，结论可以是空仓或否定该模型；继续扩大搜索直到找到盈利组合不属于有效验证。','',
        '## 验证与复现','',f"审计：`{json.dumps(audit,ensure_ascii=False)}`。",'',
        '```sh',
        '.cache/thetadata-venv/bin/python services/theta/pde_search_data.py --bulk',
        '.cache/thetadata-venv/bin/python services/theta/pde_search.py run',
        '.cache/thetadata-venv/bin/python services/theta/audit_search.py',
        '.cache/thetadata-venv/bin/python services/theta/report_search.py',
        'npm run theta:test','```','',
        f"![结算收益与回撤]({OUT/'comparison.png'})",'',
        f"计划：[pde-e03.json]({ROOT/'research/options/pde-e03.json'})；实现说明：[pde-e03-implementation.md]({ROOT/'research/options/pde-e03-implementation.md'})。",'',
        '数据文件含全部时点预测、候选评分、交易、拒绝记录和审计；不包含 API 密钥。']
    (OUT/'report.md').write_text('\n'.join(lines)+'\n')
    (ROOT/'docs/pde-e03-conclusions.md').write_text('\n'.join([*header,
        '本轮落实完整密度、P/Q 优势分解、有限组合搜索、过去数据选模型、允许空仓及成本压力。没有完成实盘执行，也没有未触碰的验证样本。','',
        f"[完整报告]({OUT/'report.md'}) · [统计与不确定性]({OUT/'statistical-summary.json'}) · [审计]({OUT/'audit.json'})",'',
        f"![结算收益与回撤]({OUT/'comparison.png'})"])+'\n')
    print(json.dumps({'report':str(OUT/'report.md'),'summary':str(ROOT/'docs/pde-e03-conclusions.md'),
                      'primary':primary,'evaluation':late},ensure_ascii=False,indent=2))


if __name__=='__main__':
    report()
