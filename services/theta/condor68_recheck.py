"""Recompute the fixed 68% iron condor from raw E02 quotes, without retuning."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
import json
import os
from statistics import mean

from forecast import plan as forecast_plan
from method_lock import ROOT, verify_method
from pde import plan as candidate_plan
from pde_history import read_chain, sha
from range_model import option_prediction
from replay import legs_for_band, open_cost

OUT = ROOT / 'data/thetadata/condor68-recheck'


def summarize(rows, field):
    values = [r[field] for r in rows]
    wins = [v for v in values if v > 0]
    losses = [v for v in values if v < 0]
    cumulative = peak = drawdown = 0.
    peak_date = drawdown_peak = drawdown_trough = None
    streak = longest = 0
    for row in rows:
        value = row[field]
        cumulative += value
        if cumulative > peak:
            peak, peak_date = cumulative, row['date']
        if peak-cumulative > drawdown:
            drawdown = peak-cumulative
            drawdown_peak, drawdown_trough = peak_date, row['date']
        streak = streak+1 if value < 0 else 0
        longest = max(longest, streak)
    return {'trades':len(rows),'wins':len(wins),'losses':len(losses),
            'breakevens':len(values)-len(wins)-len(losses),
            'win_rate':len(wins)/len(values), 'net_pnl_usd':sum(values),
            'mean_pnl_usd':mean(values),'mean_win_usd':mean(wins) if wins else None,
            'mean_loss_usd':mean(losses) if losses else None,
            'gross_winning_pnl_usd':sum(wins),'gross_losing_pnl_usd':sum(losses),
            'profit_factor':sum(wins)/-sum(losses) if losses else None,
            'best_trade_usd':max(values),'worst_trade_usd':min(values),
            'daily_settled_max_drawdown_usd':drawdown,
            'drawdown_peak_date':drawdown_peak,'drawdown_trough_date':drawdown_trough,
            'longest_losing_streak_trades':longest}


def run():
    verify_method()
    archived_path=ROOT/'data/thetadata/pde-e02/results.json'
    archived=json.loads(archived_path.read_text())
    cplan=candidate_plan()
    daily_path=ROOT/'data/thetadata/pde-e02/daily-input.json'
    assert sha(daily_path)==archived['input_hashes']['daily_sha256']
    assert sha(ROOT/'research/options/pde-e01.json')==archived['input_hashes']['candidate_plan_sha256']
    closes={r['date']:r['close'] for r in json.loads(daily_path.read_text())['rows']}
    original={r['date']:r for r in archived['candidate_records']
              if r['candidate']=='iron_condor_68_10' and r['probability_model']=='Q0'}
    trades, skipped = [], []
    # Use all 177 pre-existing paired evaluation dates, not a profitable subset.
    for forecast in archived['forecasts']:
        day=forecast['date']
        chain, source=read_chain(day)
        assert source['sha256']==archived['input_hashes']['quotes'][day]
        pred=option_prediction(day,chain,forecast_plan())
        assert pred==forecast['implied']
        legs=legs_for_band(*pred['bands']['68'],cplan['vertical_width'],cplan['strike_step'])
        natural,mid=open_cost(legs,chain,'natural'),open_cost(legs,chain,'mid')
        if natural is None or mid is None:
            assert original[day]['status']=='skipped'
            skipped.append({'date':day,'reason':'Required quote or execution-side displayed size unavailable'})
            continue
        assert -cplan['vertical_width']-1e-8 <= mid <= 1e-8
        assert natural >= -cplan['vertical_width']-1e-8
        assert original[day]['legs']==legs
        assert abs(original[day]['entry_debit_points']-natural)<1e-8
        # Outcome is accessed only after geometry and entry price are fixed.
        close=closes[day]
        intrinsic=lambda spot:100*sum(l['qty']*max((spot-l['strike']) if l['right']=='call'
                                                  else (l['strike']-spot),0) for l in legs)
        fees=sum(abs(l['qty']) for l in legs)*cplan['fee_per_contract_usd']
        base=intrinsic(close)-natural*100-fees
        stress=base-sum(abs(l['qty']) for l in legs)*100*cplan['cost_stress_slippage_per_contract_points']
        endpoints=[0.]+[l['strike'] for l in legs]
        payoffs=[intrinsic(s)-natural*100-fees for s in endpoints]
        assert min(payoffs)-1e-6 <= base <= max(payoffs)+1e-6
        assert abs(base-original[day]['observed_base_pnl_usd'])<1e-6
        assert abs(stress-original[day]['observed_stressed_pnl_usd'])<1e-6
        trades.append({'date':day,'range68':pred['bands']['68'],'legs':legs,
                       'entry_debit_points':natural,'opening_fees_usd':fees,
                       'observed_spx_close_proxy':close,'base_pnl_usd':base,'stress_pnl_usd':stress,
                       'max_profit_usd':max(payoffs),'max_loss_usd':-min(payoffs),
                       'source':source})
    assert len(trades)+len(skipped)==len(archived['forecasts'])
    base=summarize(trades,'base_pnl_usd');stress=summarize(trades,'stress_pnl_usd')
    months=defaultdict(list)
    for row in trades:
        months[row['date'][:7]].append(row)
    monthly=[{'month':m,'base':summarize(rows,'base_pnl_usd'),
              'stress':summarize(rows,'stress_pnl_usd')} for m,rows in sorted(months.items())]
    result={'created_at':datetime.now(timezone.utc).isoformat(),
            'sample_start':archived['forecasts'][0]['date'],'sample_end':archived['forecasts'][-1]['date'],
            'eligible_days':len(archived['forecasts']), 'base':base,'stress':stress,
            'mean_quoted_max_profit_usd':mean(r['max_profit_usd'] for r in trades),
            'range_covered_count':sum(r['range68'][0]<=r['observed_spx_close_proxy']<=r['range68'][1] for r in trades),
            'worst_5_trades':sorted(trades,key=lambda r:r['base_pnl_usd'])[:5],
            'monthly':monthly,'skipped':skipped,'trades':trades,
            'audit':{'recomputed_from_raw_chains':True,'matched_all_archived_rows':True,
                     'frozen_method_verified':True,'source_results_sha256':sha(archived_path)},
            'rules':'Q0 nominal 68%; 10:00 ET entry; same-day SPXW PM expiry; outward strike rounding; 10-point wings; one group; buy ask/sell bid; $1.50 per contract opening fees; hold intact to expiry; no stop/target or EV filter.',
            'limitations':'Retrospective inspected sample. SPX daily close is a PM settlement proxy; no intraday drawdown, close/exercise fees or account ROI. Extra $2/contract is a sensitivity, not measured slippage. This is not the overnight next-day-expiry strategy.'}
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    report(result)
    plot(result)
    print(json.dumps({k:v for k,v in result.items() if k not in ('trades','worst_5_trades')},ensure_ascii=False,indent=2))


def report(d):
    lines=['# 68% 区间铁秃鹰：从原始行情重新计算','',
           f"区间：{d['sample_start']} 至 {d['sample_end']}。使用原 E02 相同的 {d['eligible_days']} 个评估日，避免更换比较样本；{len(d['trades'])} 笔成交假设、{len(d['skipped'])} 日跳过。",'',
           '## 固定规则','',
           '- 冻结 v1 平值期权隐含模型，名义 68% 收盘区间；这不是“博主 68% 信号”的回测。',
           '- 美东 10:00 开仓；SPXW 当天 PM 到期，向区间外侧取整至 5 点行权价，再各买入相隔 10 点的保护翼。',
           '- 每次一组；每天有合格数据就计算，不加方向筛选、EV 筛选、止盈止损或调仓。',
           '- 买 ask、卖 bid，开仓费用每张 $1.50，四张共 $6。压力场景再扣每张 $2、每组 $8 的额外滑点。',
           '- 完整持有到期，SPX 日收盘作为 PM 结算代理；没有额外平仓或结算费。',
           '- 这是当天到期的历史验证，不是现在夜盘开明日到期、剩余约 36 小时的策略。','',
           '## 成绩','',
           '| 指标 | 买卖价＋开仓费用 | 再加每组 $8 滑点压力 |','|---|---:|---:|']
    names={'trades':'交易次数','wins':'盈利笔数','losses':'亏损笔数','net_pnl_usd':'累计净损益（美元）',
           'mean_pnl_usd':'平均每笔净损益（美元）','mean_win_usd':'盈利单平均利润（美元）',
           'mean_loss_usd':'亏损单平均损失（美元）','daily_settled_max_drawdown_usd':'每日结算最大回撤（美元）',
           'best_trade_usd':'最好单笔（美元）','worst_trade_usd':'最差单笔（美元）',
           'longest_losing_streak_trades':'最长连续亏损（笔）'}
    for key,name in names.items():
        lines.append(f"| {name} | {d['base'][key]:,.2f} | {d['stress'][key]:,.2f} |")
    lines.append(f"| 胜率 | {d['base']['win_rate']:.2%} | {d['stress']['win_rate']:.2%} |")
    lines += ['',f"基础场景盈利交易合计 ${d['base']['gross_winning_pnl_usd']:,.2f}，亏损交易合计 ${d['base']['gross_losing_pnl_usd']:,.2f}。盈利因子（总盈利/总亏损绝对值）为 {d['base']['profit_factor']:.3f}，低于 1。",'',
              f"基础场景最大回撤从 {d['base']['drawdown_peak_date'] or '样本起点'} 到 {d['base']['drawdown_trough_date']}。这是累计每日结算损益的峰谷差，不包含盘中浮亏，不是账户回撤百分比。",'',
              '## 逐月表现','', '| 月份 | 笔数 | 盈/亏 | 基础净损益 | 压力净损益 |','|---|---:|---:|---:|---:|']
    for row in d['monthly']:
        b,s=row['base'],row['stress']
        lines.append(f"| {row['month']} | {b['trades']} | {b['wins']}/{b['losses']} | ${b['net_pnl_usd']:,.2f} | ${s['net_pnl_usd']:,.2f} |")
    lines += ['', '首月从 12 月 16 日开始，末月截止 9 月 15 日，并非完整自然月。','',
              '## 跳过与核验','']
    lines += [f"- {r['date']}：所需合约报价或执行侧挂单量不足，没有补造成交。" for r in d['skipped']]
    lines += ['- 所有日期从原始 10:00 期权链重新拟合、选行权价、计算现金流，与 E02 的全部对应记录一致；冻结模型及行情哈希核对通过。',
              '- 本次没有增加历史数据、调整参数或寻找最好区间。数据已被查看，是历史复核，不能当成新的独立样本外检验。','',
              '## 结论','', '固定地每天做 68% 区间、10 点保护翼的铁秃鹰，在这段历史中亏损。它确实让盈利单平均赚到约 $177，但亏损单平均约 $662，亏损累计超过盈利累计。不能直接推断所有 68% 策略都无效，也不能把本结果用于提前一天开仓的策略。','',
              f"![累计损益和回撤]({OUT/'equity-drawdown.png'})",'']
    (OUT/'report.md').write_text('\n'.join(lines))


def plot(d):
    os.environ.setdefault('MPLCONFIGDIR',str(ROOT/'.cache/matplotlib'))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    import numpy as np
    dates=[datetime.fromisoformat(r['date']) for r in d['trades']]
    dates=[dates[0]]+dates
    fig, axes=plt.subplots(2,1,figsize=(11,7),sharex=True,layout='constrained')
    for field,label,color in [('base_pnl_usd','Bid/ask + opening fees','#167d9a'),
                              ('stress_pnl_usd','Plus $8/group slippage stress','#c5662b')]:
        curve=np.r_[0,np.cumsum([r[field] for r in d['trades']])]
        drawdown=curve-np.maximum.accumulate(curve)
        axes[0].plot(dates,curve,lw=2,label=label,color=color)
        axes[1].plot(dates,drawdown,lw=1.8,color=color)
    axes[0].set_title(f"SPXW 68% iron condor | 10-point wings | {d['base']['trades']} trades",loc='left',weight='bold')
    axes[0].set_ylabel('Cumulative P&L (USD)')
    axes[0].legend(frameon=False)
    axes[1].set_ylabel('Daily-settled drawdown (USD)')
    axes[1].xaxis.set_major_locator(mdates.MonthLocator())
    axes[1].xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m'))
    for ax in axes:
        ax.axhline(0,color='#555',lw=.8)
        ax.grid(alpha=.2)
        ax.spines[['top','right']].set_visible(False)
    fig.text(.01,-.015,'One group per eligible day; 10:00 ET entry; same-day expiry; no account return or intraday drawdown.',fontsize=9)
    fig.savefig(OUT/'equity-drawdown.png',dpi=150,bbox_inches='tight')
    plt.close(fig)


if __name__=='__main__':
    run()
