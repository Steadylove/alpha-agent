"""Fixed exploratory iron-condor filters, integer risk sizing and minute exits."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math

from intraday import OUT, PLAN, candidates, download, inputs, load_chains, write_json
from replay import intrinsic, quote_valid

FILTER_NAMES = {'baseline': '原规则', 'both_sides': '双侧覆盖费用', 'price_quality': '报价质量过滤'}
EXIT_NAMES = {'expiry': '持有到期', 'time_1530': '15:30退出', 'tp50': '止盈50%',
              'tp50_sl25': '止盈50%＋止损25%风险'}


def entry_metrics(trade, plan, slippage=0):
    """All dollar figures here are per group; no account sizing or future prices."""
    fee = plan['fee_per_contract']
    contracts = sum(abs(q['qty']) for q in trade['entry_quotes'])
    credit = -trade['debit_usd'] - contracts * slippage * 100
    half_spread = sum(abs(q['qty']) * (q['ask']-q['bid']) * 50 for q in trade['entry_quotes'])
    max_profit = credit - contracts * fee
    expiry_risk = trade['width'] * 100 - credit + contracts * fee
    # Allow four closing commissions. Stress prices are constrained to width at exit;
    # the entry credit already includes opening adverse slippage.
    budget_risk = expiry_risk + contracts * fee
    capacity = min(int(q['ask_size' if q['qty'] > 0 else 'bid_size']) // abs(q['qty'])
                   for q in trade['entry_quotes'])
    return {'credit': credit, 'open_fee': contracts*fee, 'max_profit': max_profit,
            'expiry_risk': expiry_risk, 'budget_risk': budget_risk,
            'half_spread': half_spread, 'reward_risk': max_profit/expiry_risk,
            'half_spread_credit_ratio': half_spread/credit if credit > 0 else math.inf,
            'both_sides': all(c - 2*slippage*100 > 2*fee + 1e-8 for c in trade['side_credits_usd']),
            'entry_capacity_groups': capacity,
            'collateral': trade['width']*100 + 2*contracts*fee}


def filter_passes(metrics, name, plan):
    if not (metrics['credit'] > 0 and metrics['max_profit'] > 0):
        return False
    if name == 'baseline':
        return True
    if not metrics['both_sides']:
        return False
    if name == 'both_sides':
        return True
    quality = plan['price_quality']
    return (metrics['reward_risk'] >= quality['minimum_net_reward_to_expiry_risk']
            and metrics['half_spread_credit_ratio'] <= quality['maximum_half_spread_to_gross_credit'])


def position_size(equity, fraction, metrics):
    if equity <= 0:
        return 0
    return max(0, min(math.floor((equity*fraction + 1e-8)/metrics['budget_risk']),
                      math.floor((equity + 1e-8)/metrics['collateral']),
                      metrics['entry_capacity_groups']))


def close_quote(trade, chain, groups, fee, slippage, limit_cost=True):
    """Close shorts and saleable longs; keep zero-bid longs to PM settlement.

    Returns per-group cash and fee, but validates displayed depth for all groups.
    Missing/crossed/nonfinite quotes are never made into an executable price.
    """
    cash = closing_fee = 0.0
    residual, executed = [], []
    for leg in trade['legs']:
        q = chain.get((float(leg['strike']), leg['right']))
        if not q:
            return None
        bid, ask = q.get('bid'), q.get('ask')
        if not all(isinstance(x, (int, float)) and math.isfinite(x) for x in (bid, ask)) or not 0 <= bid <= ask:
            return None
        side = 'bid' if leg['qty'] > 0 else 'ask'
        if leg['qty'] > 0 and bid <= slippage:
            residual.append(dict(leg))
            continue
        if not quote_valid(q, side, leg['qty']*groups):
            return None
        price = bid-slippage if leg['qty'] > 0 else ask+slippage
        cash += leg['qty'] * price * 100
        closing_fee += abs(leg['qty']) * fee
        executed.append({**leg, 'price': price, 'bid': bid, 'ask': ask,
                         'bid_size': q['bid_size'], 'ask_size': q['ask_size']})
    # Do not pay more to remove this defined-risk position than its maximum
    # remaining settlement liability. Leave the exit pending instead.
    if limit_cost and not -trade['width']*100 - 1e-7 <= cash <= 1e-7:
        return None
    return {'cash': cash, 'fee': closing_fee, 'residual': residual, 'executed': executed}


def liquidation_marks(trade, chains, result, plan, groups, slippage):
    """Observable minute liquidation estimates, including retained long wings.

    These are not fills. Wide multi-leg quotes may imply losses worse than holding
    to expiry; preserve such marks instead of clipping reported drawdowns.
    """
    metrics = entry_metrics(trade, plan, slippage)
    entry_net = metrics['credit']-metrics['open_fee']
    marks = []
    cursor = datetime.fromisoformat(f"{trade['date']}T{plan['entry_time_et']}")
    end = cursor.replace(hour=16, minute=0)
    while cursor < end:
        stamp = cursor.strftime('%H:%M:%S')
        chain = chains.get(stamp, {})
        if result['exit_reason'] == 'expiry' or stamp < result['exit_time_et']:
            quote = close_quote(trade, chain, groups, plan['fee_per_contract'], slippage, limit_cost=False)
            mark = None if quote is None else entry_net+quote['cash']-quote['fee']
        else:
            mark = entry_net+result['close_cash_usd']-result['close_fee_usd']
            for leg in result['residual_legs']:
                q = chain.get((float(leg['strike']), leg['right']))
                if not q or not all(math.isfinite(q[k]) for k in ('bid','ask')) or not 0 <= q['bid'] <= q['ask']:
                    mark = None
                    break
                if q['bid'] <= slippage:
                    continue
                if not quote_valid(q, 'bid', leg['qty']*groups):
                    mark = None
                    break
                mark += leg['qty']*((q['bid']-slippage)*100-plan['fee_per_contract'])
        if mark is not None:
            marks.append({'time_et': stamp, 'pnl_per_group_usd': round(mark, 6)})
        cursor += timedelta(minutes=1)
    marks.append({'time_et':'16:00:00', 'pnl_per_group_usd': result['net_pnl_per_group_usd']})
    return marks


def simulate_exit(trade, chains, plan, exit_name, groups=1, slippage=0):
    metrics = entry_metrics(trade, plan, slippage)
    entry_net = metrics['credit'] - metrics['open_fee']
    expiry_value = sum(leg['qty'] * intrinsic(trade['settlement_price'], leg['strike'], leg['right'])
                       for leg in trade['legs']) * 100
    terminal = entry_net + expiry_value
    result = {'exit_rule': exit_name, 'exit_reason': 'expiry', 'exit_time_et': '16:00:00',
              'trigger_time_et': None, 'trigger_pnl_usd': None,
              'entry_credit_usd': metrics['credit'], 'open_fee_usd': metrics['open_fee'],
              'close_cash_usd': None, 'close_fee_usd': 0.0, 'residual_legs': [],
              'residual_settlement_usd': 0.0, 'expiry_value_usd': expiry_value,
              'net_pnl_per_group_usd': terminal, 'risk_per_group_usd': metrics['budget_risk'],
              'missing_quote_minutes': 0, 'unexecutable_quote_minutes': 0,
              'pending_exit_unfilled': False, 'closed_quotes': []}
    if exit_name == 'expiry':
        return result
    cursor = datetime.fromisoformat(f"{trade['date']}T{plan['entry_time_et']}") + timedelta(minutes=1)
    end = cursor.replace(hour=16, minute=0)
    pending = None
    while cursor < end:
        stamp = cursor.strftime('%H:%M:%S')
        chain = chains.get(stamp, {})
        complete = all((float(l['strike']), l['right']) in chain for l in trade['legs'])
        quote = close_quote(trade, chain, groups, plan['fee_per_contract'], slippage)
        if not complete:
            result['missing_quote_minutes'] += 1
        elif quote is None:
            result['unexecutable_quote_minutes'] += 1
        if exit_name == 'time_1530' and stamp >= '15:30:00' and pending is None:
            pending = {'reason': 'time', 'at': cursor, 'signal_time': '15:29:00', 'signal_pnl': None}
        if pending and cursor >= pending['at'] and quote is not None:
            residual = sum(l['qty'] * intrinsic(trade['settlement_price'], l['strike'], l['right'])
                           for l in quote['residual']) * 100
            result.update({'exit_reason': pending['reason'], 'exit_time_et': stamp,
                           'trigger_time_et': pending['signal_time'], 'trigger_pnl_usd': pending['signal_pnl'],
                           'close_cash_usd': quote['cash'], 'close_fee_usd': quote['fee'],
                           'residual_legs': quote['residual'], 'residual_settlement_usd': residual,
                           'closed_quotes': quote['executed'],
                           'net_pnl_per_group_usd': entry_net+quote['cash']-quote['fee']+residual})
            break
        if pending is None and quote is not None and exit_name in ('tp50', 'tp50_sl25'):
            # Signal excludes future residual-wing payoff. It is based only on
            # the currently observed, depth-checked liquidation quote.
            mark = entry_net + quote['cash'] - quote['fee']
            reason = None
            if mark >= plan['take_profit_fraction_of_net_max_profit'] * metrics['max_profit']:
                reason = 'take_profit'
            elif exit_name == 'tp50_sl25' and mark <= -plan['stop_loss_fraction_of_expiry_max_loss'] * metrics['expiry_risk']:
                reason = 'stop_loss'
            if reason:
                pending = {'reason': reason, 'at': cursor+timedelta(minutes=plan['exit_delay_minutes']),
                           'signal_time': stamp, 'signal_pnl': mark}
        cursor += timedelta(minutes=1)
    if pending and result['exit_reason'] == 'expiry':
        result['pending_exit_unfilled'] = True
        result['trigger_time_et'] = pending['signal_time']
        result['trigger_pnl_usd'] = pending['signal_pnl']
    if result['net_pnl_per_group_usd'] < -metrics['budget_risk'] - 1e-5:
        raise AssertionError('Realized loss exceeds the risk sizing reserve')
    return result


def summarize_series(rows, spec, initial_equity, mark_paths=None):
    trades = [r for r in rows if r['status'] == 'traded']
    wins = [r['pnl_usd'] for r in trades if r['pnl_usd'] > 1e-8]
    losses = [r['pnl_usd'] for r in trades if r['pnl_usd'] < -1e-8]
    equity = peak = initial_equity or 0.0
    peak_date = 'start'
    max_dd = max_dd_pct = 0.0
    dd_dates = None
    streak = max_streak = 0
    curve = []
    intraday_peak = initial_equity or 0.0
    intraday_dd = intraday_dd_pct = 0.0
    intraday_dd_dates = None
    intraday_peak_date = 'start'
    for row in rows:
        if row['status'] == 'traded' and mark_paths is not None:
            for point in mark_paths[row['path_id']]:
                marked_equity = equity+point['pnl_per_group_usd']*row['groups']
                stamp = row['date']+' '+point['time_et']
                if marked_equity > intraday_peak:
                    intraday_peak, intraday_peak_date = marked_equity, stamp
                dd = intraday_peak-marked_equity
                if dd > intraday_dd:
                    intraday_dd, intraday_dd_dates = dd, [intraday_peak_date, stamp]
                if initial_equity and intraday_peak > 0:
                    intraday_dd_pct = max(intraday_dd_pct, dd/intraday_peak*100)
        equity += row['pnl_usd']
        if equity > peak:
            peak, peak_date = equity, row['date']
        dd = peak-equity
        if dd > max_dd:
            max_dd, dd_dates = dd, [peak_date, row['date']]
        if initial_equity and peak > 0:
            max_dd_pct = max(max_dd_pct, dd/peak*100)
        if row['status'] == 'traded':
            streak = streak+1 if row['pnl_usd'] < -1e-8 else 0
            max_streak = max(max_streak, streak)
        curve.append({'date': row['date'], 'pnl_usd': round(row['pnl_usd'], 6),
                      'cumulative_pnl_usd': round(equity-(initial_equity or 0), 6),
                      'equity_usd': round(equity, 6) if initial_equity else None,
                      'groups': row.get('groups', 0)})
    net = sum(r['pnl_usd'] for r in trades)
    monthly = {}
    for row in rows:
        month = row['date'][:7]
        monthly[month] = monthly.get(month, 0)+row['pnl_usd']
    return {**spec, 'sessions': len(rows), 'trades': len(trades),
            'groups': sum(r['groups'] for r in trades), 'wins': len(wins), 'losses': len(losses),
            'win_rate': len(wins)/len(trades) if trades else None,
            'net_pnl_usd': round(net, 6), 'return_pct': net/initial_equity*100 if initial_equity else None,
            'daily_max_drawdown_usd': round(max_dd, 6),
            'daily_max_drawdown_pct': max_dd_pct if initial_equity else None,
            'sampled_liquidation_max_drawdown_usd': round(intraday_dd, 6),
            'sampled_liquidation_max_drawdown_pct': intraday_dd_pct if initial_equity else None,
            'sampled_liquidation_drawdown_dates': intraday_dd_dates,
            'drawdown_dates': dd_dates, 'mean_win_usd': sum(wins)/len(wins) if wins else None,
            'mean_loss_usd': sum(losses)/len(losses) if losses else None,
            'realized_reward_risk': (sum(wins)/len(wins))/(-sum(losses)/len(losses)) if wins and losses else None,
            'worst_trade_usd': min((r['pnl_usd'] for r in trades), default=None),
            'max_losing_streak': max_streak,
            'skip_reasons': dict(Counter(r['reason'] for r in rows if r['status'] != 'traded')),
            'exit_reasons': dict(Counter(r['exit_reason'] for r in trades)),
            'unfilled_exits': sum(r['pending_exit_unfilled'] for r in trades),
            'trades_retaining_wings': sum(bool(r['residual_legs']) for r in trades),
            'monthly_pnl_usd': {k: round(v, 6) for k,v in monthly.items()}, 'curve': curve}


def replay(capital=20000, risk_fraction=.01):
    plan, ledger = inputs()
    if not math.isfinite(capital) or capital <= 0 or not math.isfinite(risk_fraction) or not 0 < risk_fraction <= 1:
        raise ValueError('Capital must be positive and risk fraction in (0, 1]')
    registered = json.loads((OUT/'registered-plan.json').read_text())
    if registered['plan_sha256'] != hashlib.sha256(PLAN.read_bytes()).hexdigest():
        raise ValueError('Plan changed after registration')
    entries = candidates(plan, ledger)
    chain_cache, path_cache, mark_paths = {}, {}, {}
    quote_checks = 0
    for trade in entries:
        if trade['status'] != 'priced':
            continue
        key = trade['date'], trade['band'], trade['width']
        chains = load_chains(trade['date'], trade['legs'])
        for old in trade['entry_quotes']:
            q = chains[plan['entry_time_et']][(float(old['strike']), old['right'])]
            if any(abs(q[k]-old[k]) > 1e-7 for k in ('bid', 'ask', 'bid_size', 'ask_size')):
                raise ValueError(f'Entry snapshot differs from minute history: {key}')
            quote_checks += 1
        chain_cache[key] = chains
    summaries, all_rows = [], []
    account_cases = [None, *dict.fromkeys([float(capital), 100000.0])]
    for slippage in plan['extra_slippage_per_contract_points']:
        for band in plan['bands']:
            for width in plan['wing_widths']:
                day_entries = [r for r in entries if r['band'] == band and r['width'] == width]
                for filter_name in plan['filters']:
                    for exit_name in plan['exits']:
                        for initial_equity in account_cases:
                            spec = {'band': band, 'width': width, 'filter': filter_name, 'exit': exit_name,
                                    'extra_slippage_points': slippage, 'initial_equity': initial_equity,
                                    'risk_fraction': risk_fraction if initial_equity else None}
                            equity = initial_equity
                            rows = []
                            for trade in day_entries:
                                row = {**spec, 'date': trade['date'], 'status': 'skipped', 'pnl_usd': 0.0,
                                       'equity_before_usd': equity, 'groups': 0}
                                if trade['status'] != 'priced':
                                    row['reason'] = trade['reason']
                                else:
                                    metrics = entry_metrics(trade, plan, slippage)
                                    if not filter_passes(metrics, filter_name, plan):
                                        row['reason'] = 'entry_filter'
                                    else:
                                        groups = position_size(equity, risk_fraction, metrics) if initial_equity else 1
                                        if groups == 0:
                                            row['reason'] = 'risk_budget_or_collateral'
                                        else:
                                            key = trade['date'], band, width
                                            sim_key = *key, exit_name, slippage, groups
                                            if sim_key not in path_cache:
                                                path_cache[sim_key] = simulate_exit(trade, chain_cache[key], plan, exit_name, groups, slippage)
                                                path_id = '|'.join(map(str, sim_key))
                                                path_cache[sim_key]['path_id'] = path_id
                                                mark_paths[path_id] = liquidation_marks(trade, chain_cache[key], path_cache[sim_key], plan, groups, slippage)
                                            result = path_cache[sim_key]
                                            row.update({**result, 'status': 'traded', 'groups': groups,
                                                'pnl_usd': result['net_pnl_per_group_usd']*groups,
                                                'risk_allocated_usd': metrics['budget_risk']*groups,
                                                'legs': trade['legs'], 'settlement_price': trade['settlement_price'],
                                                'entry_quotes': trade['entry_quotes'],
                                                'entry_reward_risk': metrics['reward_risk'],
                                                'entry_half_spread_credit_ratio': metrics['half_spread_credit_ratio']})
                                            if initial_equity:
                                                if row['risk_allocated_usd'] > equity*risk_fraction+1e-5:
                                                    raise AssertionError('Sizing exceeded risk budget')
                                                equity += row['pnl_usd']
                                rows.append(row)
                            summaries.append(summarize_series(rows, spec, initial_equity, mark_paths))
                            all_rows.extend(rows)
    result = {'created_at': datetime.now(timezone.utc).isoformat(), 'registered_plan': registered,
              'account_assumption': {'primary_capital': capital, 'risk_fraction': risk_fraction,
                                     'capital_sensitivity': 100000},
              'ledger': ledger, 'entry_quote_crosschecks': quote_checks,
              'summaries': summaries, 'trades': all_rows}
    write_json(OUT/'results.json', result)
    write_json(OUT/'minute-marks.json', mark_paths)
    # CSV is a convenience export of the research output, not a separate model.
    import csv
    with (OUT/'summary.csv').open('w', newline='') as f:
        fields = [k for k in summaries[0] if k not in ('curve', 'monthly_pnl_usd', 'skip_reasons', 'exit_reasons')]
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(summaries)
    write_report(result)
    print(f'Completed {len(summaries)} series; {len(all_rows)} daily scenarios; {quote_checks} entry quotes cross-checked.', flush=True)
    return result


def money(value):
    return '—' if value is None else f'{value:,.2f}'


def table_rows(summaries, account=None, slippage=0):
    lines = ['| 区间／翼宽 | 过滤 | 退出 | 交易日／组数 | 净利润 $ | 胜率 | 平均盈亏比 | 最大逐日回撤 $ | 分钟盘口回撤 $ | 最差一笔 $ |',
             '|---|---|---|---:|---:|---:|---:|---:|---:|---:|']
    for s in summaries:
        if s['initial_equity'] != account or s['extra_slippage_points'] != slippage:
            continue
        rate = '—' if s['win_rate'] is None else f"{s['win_rate']*100:.1f}%"
        lines.append(f"| {s['band']}%／{s['width']} | {FILTER_NAMES[s['filter']]} | {EXIT_NAMES[s['exit']]} | "
                     f"{s['trades']}／{s['groups']} | {money(s['net_pnl_usd'])} | {rate} | "
                     f"{money(s['realized_reward_risk'])} | {money(s['daily_max_drawdown_usd'])} | {money(s['sampled_liquidation_max_drawdown_usd'])} | {money(s['worst_trade_usd'])} |")
    return lines


def write_report(result):
    account = result['account_assumption']
    capital, fraction = account['primary_capital'], account['risk_fraction']
    plan = result['registered_plan']['plan']
    summaries = result['summaries']
    status = json.loads((OUT/'download-status.json').read_text())
    lines = ['# 铁秃鹰优化研究 v1：报价过滤、风险预算与盘中退出', '',
        '## 本轮结论', '',
        '**存在值得继续验证的改进，但没有找到能保证连续交易盈利的规则。**', '',
        '- 在完全相同的 31 次开仓、68% 区间和 10 点翼宽下，15:30 退出将样本净利润从 $846 提高到 $1,507，逐日回撤从 $836 降至 $391；历史平均盈利 / 平均亏损从 0.16 提高至 1.39，但胜率从 90.3% 降到 71.0%。',
        '- 固定止盈加止损并未改善这组交易：累计变成 -$1,562。10 次止损中，有 7 次若持有到期原本会盈利；这条止损规则不能直接采用。',
        '- 双侧覆盖费用后，15:30 退出的样本净利润为 $1,505，但只有 13 次交易；更严格的报价过滤只剩 7 次（95% 区间仅 1 次），证据不足以推断未来胜率。',
        '- 15:30 退出对 95% 区间原规则效果相反：10 点翼宽净利润 $259 → $81.50；增加每张每次 $2 成本压力后为 -$30.50。不能据 68% 的结果说提前退出普遍有效。',
        '- 低逐日回撤不代表低盘中波动：双侧过滤＋15:30 退出的逐日回撤仅 $9，但分钟盘口估值回撤约 $1,017.50，其中包含无法保证成交的宽价差；完整定义和全部对照见下文。',
        '- 默认 2 万美元、1% 单笔风险的演示账户，所有候选都超出 $200 风险预算，因此没有开仓。每次一组的盈利并非该账户能实际执行的结果。', '',
        '## 研究边界', '',
        '- 样本：2026-07-23 至 2026-09-15，38 个已查看过的历史预测日；所有参数都是探索性对照。没有独立样本外业绩，也没有保证未来盈利。',
        '- 历史预测的原始发布时间未独立核验；开仓条件是假设 10:00 前已经取得该区间。',
        f"- 新退出规则登记时间：{result['registered_plan']['registered_at']}；登记早于本轮盘中退出结果，但晚于此前到期损益分析。",
        f"- 新采集 {len(status['completed'])} 个合约，{sum(x['rows'] for x in status['completed'].values()):,} 条分钟报价；{result['entry_quote_crosschecks']} 条开仓腿报价与旧快照交叉核验。",
        '- 到期使用已交叉核对的 SPX 收盘值，并非券商结算记录。所有成交都是历史盘口假设。', '',
        '## 固定规则', '',
        '- 每天美东 10:00 入场；分别测试 68% / 95% 区间、10 / 20 点保护翼。各序列独立，不能叠加其利润。',
        '- 原规则：沿用原复盘的有效报价、正权利金及扣费后盈利空间要求。',
        '- 双侧覆盖费用：Put 侧和 Call 侧净权利金分别超过各自两张的开仓费。',
        '- 报价质量过滤：在双侧过滤基础上，最大净收益 / 最大到期亏损 ≥ 0.15，四腿自然价相对中间价的成本 / 总毛权利金 ≤ 25%。这些是研究阈值，不是已证明的最优值。',
        '- 退出对照：持有到期；15:30 按当时有效报价退出；达到最大净利润的 50% 时止盈；以及止盈加亏损达到最大到期损失的 25% 时止损。',
        '- 止盈止损从 10:01 起按分钟观察；触发后最早下一分钟成交，成交使用届时报价，不把阈值当成成交价。触发后退出请求保持有效，不因行情恢复而撤销。',
        '- 无有效盘口/深度或平仓支出超过翼宽价值则等待；最多尝试到 15:59，否则到期结算。缺失数据不用于反向筛掉不利交易。',
        '- 买按 ask、卖按 bid，每张每次实际成交假设收 $1.50。平仓时零买价多头翼留到期，计入最终内在价值；没有假设它们能以零价卖出。',
        '- 显示挂单量检查覆盖全部组数；NBBO 多腿同时成交、原报价年龄和分钟内触发仍无法由这些快照保证。',
        '- 逐日回撤按收盘已结算损益计算；分钟盘口回撤包含有效分钟按买卖盘、扣潜在平仓费后的估值，不是实际成交或券商净值。它可能因价差超过持有到期的损失上限；未截断这类不利估值。未观测到的分钟内波动仍可能更差。',
        '- 成本压力对照：每次成交每张额外不利 0.02 点（$2）；这可能改变选仓、触发及成交时刻。', '',
        '## 每次一组：隔离退出规则与报价过滤的影响', '',
        '下表未指定账户本金；美元盈亏不可当作账户收益率。平均盈亏比＝盈利交易平均盈利 / 亏损交易平均亏损绝对值；没有亏损样本时显示“—”，不推断无限优势。', '',
        *table_rows(summaries), '', '## 按账户最大风险预算下单', '',
        f'- 主账户仅作演示：初始 ${capital:,.0f}，每笔最多分配当前已结算净值的 {fraction*100:g}%。不代表用户已确认本金。',
        '- 每组风险准备＝最大到期损失（含开仓费及开仓滑点）＋四张平仓费。组数向下取整，再按可用现金和开仓盘口量限制；不追加资金、不借款、不亏损加倍。',
        '- 现金占用按翼宽×100加最多开平仓费用保守估计，非 IBKR 实际保证金预览。当天有残余保护翼也不复用资金。',
        '- 预算不足以买一组时跳过；零交易、零亏损不能当作优化成功。风控只改变风险承担，不创造正期望。', '',
        *table_rows(summaries, capital), '', '## 10 万美元账户的资金敏感性', '',
        f'仅改变初始本金，风险比例仍为 {fraction*100:g}%；用于展示合约不可拆分对结果的影响，不是入金建议。', '',
        *table_rows(summaries, 100000.0), '', '## 增加成交成本后的每组对照', '',
        *table_rows(summaries, None, .02), '', '## 如何验证下一阶段', '',
        '1. 这 38 天已被反复查看，不能再称为留出测试集。未来新日期先存预测正文、抓取时间和页面哈希，再开模拟仓。',
        '2. 冻结少量规则与风险预算，记录包括无交易日在内的连续结果；阈值变更另开版本，不覆盖旧版本成绩。',
        '3. 同时检查扣费收益、平均盈亏、最差交易、连续亏损、资金回撤及缺失/未成交事件；不只挑最高累计利润。',
        '4. 即使样本外结果为正，也需要评估预测失准及相关亏损；本轮不能给出可靠的未来获利概率或月收益承诺。', '',
        '## 文件与复现', '',
        '- results.json：完整规则、每条账户曲线、逐日开仓/跳过与退出价格、费用、残余翼结算。',
        '- minute-marks.json：每种实际模拟路径的分钟平仓估值，包括退出后留下的多头翼。',
        '- summary.csv：所有参数及成本、账户对照。',
        '- download-status.json：分钟报价缓存路径、条数与 SHA256。',
        '- registered-plan.json：盘中退出研究开始前登记的规则版本。',
        '- audit.json：独立现金流、风险上限、时间顺序、样本汇总和缓存校验。',
        '- comparison.png：主要规则的累计损益比较。',
        '- 命令：`npm run theta:optimize -- replay --capital 20000 --risk-pct 1`；下载：`npm run theta:optimize -- download`。',
        '- 数据说明：[ThetaData 分钟报价](https://docs.thetadata.us/operations_excel/option_history_quote.html)；[预测源](https://balder-ai.com/spx)。', '']
    (OUT/'report.md').write_text('\n'.join(lines))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['download', 'replay', 'all'], nargs='?', default='replay')
    parser.add_argument('--capital', type=float, default=20000)
    parser.add_argument('--risk-pct', type=float, default=1)
    args = parser.parse_args()
    if args.action in ('download', 'all'):
        download()
    if args.action in ('replay', 'all'):
        replay(args.capital, args.risk_pct/100)
