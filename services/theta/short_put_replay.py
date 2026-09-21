"""Fixed-rule naked short-put replay; expiry cash flows and minute liquidation risk."""
from __future__ import annotations

from collections import defaultdict
import csv
import hashlib
import json
import math

import polars as pl

from intraday import contract_path, validate_contract, write_json
from provider import ROOT
from replay import index_rows, quote_valid
from short_put_data import OUT, register


def payoff(strike, bid, close, cost):
    if not all(math.isfinite(x) for x in (strike, bid, close, cost)) or min(strike, bid, close, cost) < 0:
        raise ValueError('Invalid payoff inputs')
    return (bid - max(strike - close, 0)) * 100 - cost


def drawdown(values):
    peak = worst = 0.0
    for value in values:
        peak = max(peak, value)
        worst = max(worst, peak - value)
    return worst


def wilson(wins, n):
    if not n: return None
    z = 1.95996398454
    p = wins / n
    d = 1 + z*z/n
    mid = (p + z*z/(2*n))/d
    half = z * math.sqrt(p*(1-p)/n + z*z/(4*n*n))/d
    return [mid-half, mid+half]


def round4(x):
    return round(x, 4) if x is not None else None


def price_day(session, band, cfg):
    day = session['date']
    low, high = session['bands'][band]
    strike = math.floor(low / 5) * 5
    path = contract_path(day, strike, 'put')
    chains = validate_contract(pl.read_parquet(path), day, strike, 'put')
    quote = chains[cfg['entry_time_et']][(float(strike), 'put')]
    full = ROOT / 'data/thetadata' / day / 'entry-snapshots-1000-1030-1100.parquet'
    if full.exists():
        original = index_rows(pl.read_parquet(full).to_dicts(), day)[cfg['entry_time_et']].get((float(strike), 'put'))
        if not original or any(quote[k] != original[k] for k in ('bid', 'ask', 'bid_size', 'ask_size')):
            raise ValueError(f'{day} {strike}: minute entry differs from frozen original snapshot')
    row = {'date': day, 'band': band, 'lower_bound': low, 'upper_bound': high,
           'strike': strike, 'settlement_price': session['settlement_price'],
           'bid': float(quote['bid']), 'ask': float(quote['ask']),
           'bid_size': quote['bid_size'], 'ask_size': quote['ask_size'],
           'status': 'skipped', 'reason': '', 'quote_file_sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    if not quote_valid(quote, 'bid'):
        row['reason'] = 'No valid positive bid/size at fixed entry; no replacement or later fill'
        return row, []
    fee, slip = cfg['fee_per_contract_usd'], cfg['extra_slippage_usd']
    cost = fee + slip + cfg['expiry_settlement_fee_usd']
    bid, close = row['bid'], row['settlement_price']
    net = payoff(strike, bid, close, cost)
    maximum_profit = bid * 100 - cost
    minute_marks = []
    for stamp, chain in sorted(chains.items()):
        q = chain[(float(strike), 'put')]
        if not quote_valid(q, 'ask'): continue
        value = 100 * (bid - float(q['ask'])) - 2*(fee+slip)
        minute_marks.append({'date': day, 'band': band, 'time_et': stamp,
                             'bid': float(q['bid']), 'ask': float(q['ask']),
                             'liquidation_pnl_usd': round4(value)})
    worst_mark = min(minute_marks, key=lambda r: r['liquidation_pnl_usd']) if minute_marks else None
    row.update({'status': 'traded', 'gross_premium_usd': round4(bid*100),
                'opening_fee_usd': fee, 'extra_slippage_usd': slip,
                'net_max_profit_usd': round4(maximum_profit), 'net_pnl_usd': round4(net),
                'stress_cost_net_pnl_usd': round4(net-(cfg['stress_extra_slippage_usd']-slip)),
                'settlement_intrinsic_usd': round4(100*max(strike-close, 0)),
                'net_breakeven': round4(strike - maximum_profit/100),
                'theoretical_zero_index_max_loss_usd': round4(strike*100-maximum_profit),
                'valid_mark_minutes': len(minute_marks), 'missing_or_invalid_mark_minutes': 360-len(minute_marks),
                'worst_liquidation_pnl_usd': worst_mark['liquidation_pnl_usd'] if worst_mark else None,
                'worst_liquidation_time_et': worst_mark['time_et'] if worst_mark else None})
    for points in cfg['stress_points_below_strike']:
        row[f'stress_close_{points}_below_strike_pnl_usd'] = round4(payoff(strike, bid, max(0,strike-points), cost))
    if not -row['theoretical_zero_index_max_loss_usd']-1e-6 <= net <= maximum_profit+1e-6:
        raise ValueError('Payoff outside bounds')
    return row, minute_marks


def summarize(rows, marks):
    traded = [r for r in rows if r['status'] == 'traded']
    pnl = [r['net_pnl_usd'] for r in traded]
    wins, losses = [p for p in pnl if p > 0], [p for p in pnl if p < 0]
    grouped_marks = defaultdict(list)
    for m in marks: grouped_marks[m['date']].append(m)
    equity = 0.0
    curve, full_path, loss_streak = [], [0.0], 0
    max_streak = 0
    monthly = defaultdict(lambda: {'trades': 0, 'net_pnl_usd': 0.0})
    for r in rows:
        full_path.append(equity)
        if r['status'] == 'traded':
            for m in sorted(grouped_marks[r['date']], key=lambda x:x['time_et']):
                full_path.append(equity + m['liquidation_pnl_usd'])
            equity += r['net_pnl_usd']
            loss_streak = loss_streak+1 if r['net_pnl_usd'] < 0 else 0
            max_streak = max(max_streak, loss_streak)
            monthly[r['date'][:7]]['trades'] += 1
            monthly[r['date'][:7]]['net_pnl_usd'] += r['net_pnl_usd']
        full_path.append(equity)
        curve.append({'date':r['date'], 'cumulative_pnl_usd':round4(equity),
                      'daily_pnl_usd':r.get('net_pnl_usd',0), 'status':r['status']})
    average = lambda vals: sum(vals)/len(vals) if vals else None
    worst_intraday = min(traded, key=lambda r:r['worst_liquidation_pnl_usd']) if traded else None
    return {'band':rows[0]['band'], 'sessions':len(rows), 'trades':len(traded), 'skips':len(rows)-len(traded),
            'wins':len(wins), 'losses':len(losses), 'flat':len(pnl)-len(wins)-len(losses),
            'win_rate':len(wins)/len(pnl) if pnl else None,
            'wilson_95_interval_iid_only':wilson(len(wins),len(pnl)),
            'gross_premium_usd':round4(sum(r['gross_premium_usd'] for r in traded)),
            'total_cost_usd':round4(sum(r['gross_premium_usd']-r['net_max_profit_usd'] for r in traded)),
            'net_pnl_usd':round4(sum(pnl)),
            'stress_cost_net_pnl_usd':round4(sum(r['stress_cost_net_pnl_usd'] for r in traded)),
            'mean_net_pnl_per_trade_usd':round4(average(pnl)),
            'mean_gross_premium_usd':round4(average([r['gross_premium_usd'] for r in traded])),
            'mean_net_max_profit_usd':round4(average([r['net_max_profit_usd'] for r in traded])),
            'mean_win_usd':round4(average(wins)), 'mean_loss_usd':round4(average(losses)),
            'worst_settlement_day_usd':min(pnl,default=None), 'best_settlement_day_usd':max(pnl,default=None),
            'worst_settlement_day':min(traded,key=lambda r:r['net_pnl_usd'])['date'] if traded else None,
            'settled_equity_max_drawdown_usd':round4(drawdown([c['cumulative_pnl_usd'] for c in curve])),
            'minute_liquidation_equity_max_drawdown_usd':round4(drawdown(full_path)),
            'worst_single_trade_liquidation_pnl_usd':worst_intraday['worst_liquidation_pnl_usd'] if worst_intraday else None,
            'worst_single_trade_liquidation_date':worst_intraday['date'] if worst_intraday else None,
            'worst_single_trade_liquidation_time_et':worst_intraday['worst_liquidation_time_et'] if worst_intraday else None,
            'max_consecutive_losses':max_streak,
            'settled_itm_trades':sum(r['settlement_price']<r['strike'] for r in traded),
            'lower_bound_breach_sessions':sum(r['settlement_price']<r['lower_bound'] for r in rows),
            'max_theoretical_zero_index_loss_usd':max((r['theoretical_zero_index_max_loss_usd'] for r in traded),default=None),
            'minimum_strike':min((r['strike'] for r in traded),default=None),
            'maximum_strike':max((r['strike'] for r in traded),default=None),
            'valid_mark_minutes':sum(r['valid_mark_minutes'] for r in traded),
            'missing_or_invalid_mark_minutes':sum(r['missing_or_invalid_mark_minutes'] for r in traded),
            'monthly':dict(monthly), 'curve':curve}


def export_csv(path, rows):
    fields = list(dict.fromkeys(k for r in rows for k in r))
    with path.open('w',newline='') as f:
        w = csv.DictWriter(f,fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def plot(summaries):
    import os
    os.environ.setdefault('MPLCONFIGDIR', str(ROOT/'.cache/matplotlib'))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from datetime import date
    fig, axes = plt.subplots(2,1,figsize=(11,7.5),sharex=True,layout='constrained')
    for s,color in zip(summaries,['#1875b9','#d18418']):
        dates = [date.fromisoformat(c['date']) for c in s['curve']]
        equity = [c['cumulative_pnl_usd'] for c in s['curve']]
        peak = 0
        dd=[]
        for value in equity:
            peak=max(peak,value); dd.append(value-peak)
        axes[0].plot(dates,equity,label=f"{s['band']}% lower bound",color=color,linewidth=2)
        axes[1].plot(dates,dd,color=color,linewidth=2)
    axes[0].set_title('SPXW 0DTE short put at Balder lower bound | 1 contract/day | 10:00 ET')
    axes[0].set_ylabel('Cumulative net P&L ($)')
    axes[1].set_ylabel('Settled equity drawdown ($)')
    for ax in axes:
        ax.axhline(0,color='#777777',linewidth=.7); ax.grid(alpha=.18)
    axes[0].legend()
    fig.supxlabel('Bid entry; USD 1.50 fee + USD 2 extra cost; expiry close proxy; conditional historical replay')
    fig.savefig(OUT/'equity.png',dpi=180)
    plt.close(fig)


def report(result):
    cfg, summaries = result['plan'], result['summaries']
    lines = ['# 博主区间下沿卖出 SPXW Put：固定规则历史复盘','',
        '## 结论口径','',
        f"在这 {result['sessions']} 天的条件复盘中，两种版本均盈利：68% 下沿净赚 ${summaries[0]['net_pnl_usd']:,.2f}，95% 下沿净赚 ${summaries[1]['net_pnl_usd']:,.2f}。这支持继续验证该思路，但还不足以确认长期收益或低尾部风险。",'',
        '这是单腿裸卖 Put：看涨或横盘均可能获利，向下跌穿行权价则继续增加亏损。不是有限翼宽的蝶式或秃鹰。',
        '收益为每天一张、不复利的美元盈亏；没有用保证金或权利金充当账户本金来计算收益率。','',
        '## 固定规则与数据','',
        f"- 样本：{result['first_date']}—{result['last_date']}，{result['sessions']} 个博主公开预测交易日；68% 和 95% 是两条独立策略，不逐日择优。",
        '- 入场：美东 10:00，选当日到期 SPXW Put，行权价为区间下沿向下取最近 5 点；每天一张。',
        '- 按真实历史 bid 卖出，要求报价有效且 bid_size ≥ 1；没有报价就明确跳过，不用之后价格补填。',
        f"- 到期持有；每张开仓费用 ${cfg['fee_per_contract_usd']:.2f}，额外滑点/执行成本预留 ${cfg['extra_slippage_usd']:.2f}；到期结算额外费用假定为零。实际账户费用可能不同。",
        '- 净利润 = 100 × [入场 bid − max(行权价 − 到期指数, 0)] − 开仓费用 − 额外执行成本。',
        '- 以 SPX 收盘价代替正式结算指数，所有日期与独立日线交叉核对；未取得券商结算单。',
        '- 盘中风险使用 10:00—15:59 每分钟 ask 回补估价，并扣除假设回补时额外一笔手续费与滑点；到期策略实际没有执行回补。',
        '- 固定规则在本次盈亏计算前保存；原来的 38 个交易日此前已经被其他策略反复研究，本次不属于独立样本外验证。','',
        '## 主结果','',
        '| 指标 | 68% 下沿 | 95% 下沿 |','|---|---:|---:|']
    specs=[('实际开仓数','trades'),('跳过次数','skips'),('盈利次数','wins'),('亏损次数','losses'),
           ('总净利润（美元）','net_pnl_usd'),('每笔平均净利润（美元）','mean_net_pnl_per_trade_usd'),
           ('每笔平均毛权利金（美元）','mean_gross_premium_usd'),('平均盈利单（美元）','mean_win_usd'),
           ('平均亏损单（美元）','mean_loss_usd'),('最差到期单笔（美元）','worst_settlement_day_usd'),
           ('收盘累计盈亏最大回撤（美元）','settled_equity_max_drawdown_usd'),
           ('分钟回补估值累计盈亏最大回撤（美元）','minute_liquidation_equity_max_drawdown_usd'),
           ('最差单笔盘中回补估值（美元）','worst_single_trade_liquidation_pnl_usd'),
           ('额外执行成本提高到 $5 后总利润（美元）','stress_cost_net_pnl_usd')]
    for label,key in specs:
        vals=[s[key] for s in summaries]
        lines.append('| '+label+' | '+' | '.join('无' if v is None else f'{v:,.2f}' if isinstance(v,float) else str(v) for v in vals)+' |')
    lines += ['| 样本胜率 | '+' | '.join(f"{s['win_rate']:.2%}" for s in summaries)+' |','',
              '回撤是这段已知行情中观察到的结果，不是最大可能损失。分钟采样也会漏掉分钟内部的极值。','',
              '## 亏损日与盘中压力','']
    for s in summaries:
        lines += [f"### {s['band']}% 下沿",'',
                  f"- 收盘跌破所选 Put 行权价 {s['settled_itm_trades']} 次，净亏损 {s['losses']} 次。两者不等价，因为权利金可以覆盖部分跌幅。",
                  f"- 最差盘中单笔：{s['worst_single_trade_liquidation_date']} {s['worst_single_trade_liquidation_time_et']} ET，按 ask 回补净盈亏 ${s['worst_single_trade_liquidation_pnl_usd']:,.2f}。",
                  f"- 有效分钟估值 {s['valid_mark_minutes']:,} 条，缺失/无效分钟 {s['missing_or_invalid_mark_minutes']} 条。"]
        losses=[r for r in result['daily'] if r['band']==s['band'] and r.get('net_pnl_usd',0)<0]
        for r in losses:
            lines.append(f"- {r['date']}：下沿 {r['lower_bound']:g}，卖出 {r['strike']}P，bid {r['bid']:g} 点，收盘 {r['settlement_price']:g}，净盈亏 ${r['net_pnl_usd']:,.2f}。")
        lines.append('')
    lines += ['## 按自然月汇总（首尾月不完整）','','| 月份 | 68% 净利润 | 95% 净利润 |','|---|---:|---:|']
    for month in sorted(set().union(*(s['monthly'] for s in summaries))):
        lines.append('| '+month+' | '+' | '.join(f"${s['monthly'].get(month,{}).get('net_pnl_usd',0):,.2f}" for s in summaries)+' |')
    lines += ['', '## 尾部压力与资金','',
        '- 一张 SPXW 的乘数是 $100/点。到期落在行权价下方 50、100、200 点，需付出的内在价值分别是 $5,000、$10,000、$20,000，再减去收到的净权利金。',
        '- 上述是假设压力场景，不是发生概率预测。风险不是最多亏掉收取的权利金，也不是原来价差策略的几百或一千美元。',
        '- 理论上指数归零时的损失约为行权价 × $100 减净权利金；这不是券商保证金报价。该样本行权价意味着每张数十万美元的极端风险敞口。',
        '- 未模拟保证金上调、强制平仓、订单延迟或流动性枯竭；因此不能假定小账户能一路持有至收盘。','',
        '### 9 月 16 日实例','',
        '68% 区间下沿为 7,501，所选合约是 7,500P。10:00 bid 为 1.45 点，毛收入 $145，收盘 7,551.81，因此净赚 $141.50。盘中若按 ask 回补，最差曾显示净亏 $582。',
        '如果同一张合约到期时指数落到 7,450，净损失会是 $4,858.50；落到 7,400，净损失会是 $9,858.50。这是压力情景，不是对发生概率的估计。','',
        '## 能否据此断言稳定盈利','',
        '- 只能说明上述固定规则在这段历史和成交假设下的结果。39 天没有覆盖足够多下跌尾部；95% 版本即使没有亏损，也不能按未来零亏损处理。',
        '- 原始历史预测的发布时刻未经独立存档核实：回测有条件地假定每天 10:00 前拿到了相应区间。9 月 16 日另有用户此前提供的预测截图，但不宣称已验证其 10:00 前发布。',
        '- 历史分钟 bid/ask 不是实际成交单，挂单量也不保证真实订单一定成交；滑点压力测试只能缓解，不能消除这一差异。',
        '- 如果要求单笔损失有较小且固定的上限，应另行评估加保护 Put 的牛市看跌价差；其权利金与本次裸卖结果不同。','',
        '## 复现与文件','',
        '```sh','.cache/thetadata-venv/bin/python services/theta/short_put_data.py',
        '.cache/thetadata-venv/bin/python services/theta/short_put_replay.py','```','',
        '- registered-plan.json：执行规则、时间戳与哈希。',
        '- ledger.json：39 天区间和独立核对的收盘点位，旧 38 天与冻结账本一致。',
        '- daily-trades.csv：每笔行权价、bid/ask、成本、损益与压力场景。',
        '- minute-marks.csv：每分钟回补估值。',
        '- results.json：完整明细、汇总、数据审计与累计曲线。',
        '- equity.png：累计到期盈亏与到期口径回撤。','',
        '来源：[博主区间账本](https://balder-ai.com/spx)、[Cboe SPX 产品规格](https://www.cboe.com/tradable-products/sp-500/spx-options/spx-specifications)、已有授权 ThetaData 历史报价。','']
    text = '\n'.join(lines)
    (OUT/'report.md').write_text(text)
    (ROOT/'docs/balder-short-put-v1-conclusions.md').write_text(text)


def main():
    cfg = register()
    ledger = json.loads((OUT/'ledger.json').read_text())
    daily, marks = [], []
    for session in ledger['sessions']:
        for band in cfg['bands']:
            row, path = price_day(session,band,cfg)
            daily.append(row); marks.extend(path)
    summaries = [summarize([r for r in daily if r['band']==b],[m for m in marks if m['band']==b]) for b in cfg['bands']]
    result = {'plan':cfg, 'ledger_sha256':hashlib.sha256((OUT/'ledger.json').read_bytes()).hexdigest(),
              'sessions':len(ledger['sessions']), 'first_date':ledger['sessions'][0]['date'],
              'last_date':ledger['sessions'][-1]['date'], 'summaries':summaries, 'daily':daily}
    write_json(OUT/'results.json',result)
    export_csv(OUT/'daily-trades.csv',daily)
    export_csv(OUT/'minute-marks.csv',marks)
    report(result)
    plot(summaries)
    print(json.dumps([{k:v for k,v in s.items() if k!='curve'} for s in summaries],ensure_ascii=False,indent=2))


if __name__=='__main__': main()
