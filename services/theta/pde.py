"""PDE-E01: cached-data, terminal-payoff diagnostics without trading signals."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
from statistics import NormalDist, mean, median

from density import Lognormal, partial_integral, pnl_metrics, segments, terminal_payoff
from forecast import OUT as FORECAST_OUT, daily_data, option_prediction, plan as forecast_plan, snapshot, write_json
from method_lock import ROOT, verify_method
from replay import legs_for_band, open_cost

PLAN = ROOT / 'research/options/pde-e01.json'
OUT = ROOT / 'data/thetadata/pde-e01'
LABELS = {
    'call_butterfly_35': '看涨蝶式（35 点翼宽）',
    'iron_condor_68_10': '68% 区间铁秃鹰（10 点翼宽）',
    'iron_condor_95_10': '95% 区间铁秃鹰（10 点翼宽）',
    'call_credit_68_10': '看涨信用价差（10 点）',
    'put_credit_68_10': '看跌信用价差（10 点）',
    'bull_call_debit_atm_10': '牛市看涨借记价差（10 点）',
    'bear_put_debit_atm_10': '熊市看跌借记价差（10 点）',
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def plan():
    return json.loads(PLAN.read_text())


def candidates(prediction, cfg):
    step, width = cfg['strike_step'], cfg['vertical_width']
    center = math.floor(prediction['median'] / step + .5) * step
    half = cfg['butterfly_half_width']
    put = math.floor(prediction['bands']['68'][0] / step) * step
    call = math.ceil(prediction['bands']['68'][1] / step) * step
    leg = lambda k, r, q: {'strike': k, 'right': r, 'qty': q}
    result = {'call_butterfly_35': [leg(center-half, 'call', 1), leg(center, 'call', -2), leg(center+half, 'call', 1)]}
    for band in cfg['condor_bands']:
        result[f'iron_condor_{band}_10'] = legs_for_band(*prediction['bands'][band], width, step)
    result.update({
        'call_credit_68_10': [leg(call, 'call', -1), leg(call+width, 'call', 1)],
        'put_credit_68_10': [leg(put, 'put', -1), leg(put-width, 'put', 1)],
        'bull_call_debit_atm_10': [leg(center, 'call', 1), leg(center+width, 'call', -1)],
        'bear_put_debit_atm_10': [leg(center, 'put', 1), leg(center-width, 'put', -1)],
    })
    assert list(result) == cfg['candidates']
    return result


def analyze_day(day, prediction, chain, cfg):
    """No outcome, future quotes or physical model is accepted by this function."""
    q0 = Lognormal(prediction['forward'], prediction['total_log_volatility'])
    records = []
    for name, legs in candidates(prediction, cfg).items():
        row = {'date': day, 'candidate': name, 'legs': legs, 'status': 'skipped',
               'distribution_measure': q0.measure, 'decision': 'NO_TRADE_RESEARCH_ONLY'}
        natural = open_cost(legs, chain, 'natural')
        mid = open_cost(legs, chain, 'mid')
        if natural is None or mid is None:
            row['reason'] = 'Exact entry quote or required execution-side size unavailable'
            records.append(row)
            continue
        points = [0.] + [l['strike'] for l in legs]
        lower = min(terminal_payoff(legs, s) for s in points) / 100
        upper = max(terminal_payoff(legs, s) for s in points) / 100
        if mid < lower - 1e-8 or mid > upper + 1e-8 or natural < lower - 1e-8:
            row['reason'] = 'Cross-leg quotes violate bounded payoff price limits; no assumed arbitrage fill'
            records.append(row)
            continue
        metrics = pnl_metrics(legs, q0, natural, cfg['fee_per_contract_usd'],
                              cfg['extra_slippage_per_contract_points'], cfg['discount_factor'], cfg['tail_probability'])
        count = sum(abs(l['qty']) for l in legs)
        spread_cost = (natural-mid) * 100
        residual = metrics['expected_discounted_payoff_usd'] - mid * 100
        identity = residual - spread_cost - metrics['opening_fees_usd'] - metrics['extra_slippage_usd']
        assert abs(identity - metrics['model_ev_net_usd']) < 1e-7
        cost = natural * 100 + metrics['opening_fees_usd'] + metrics['extra_slippage_usd']
        parts = segments(legs, cost, cfg['discount_factor'])
        stress = {}
        for setting in cfg['distribution_stresses']:
            alternative = Lognormal(q0.forward * math.exp(setting['log_forward_shift_in_original_vol'] * q0.total_vol),
                                    q0.total_vol * setting['vol_multiplier'], 'hypothetical_Q0_sensitivity_not_P')
            stress[setting['id']] = partial_integral(parts, alternative)[1]
        row.update(status='priced', metrics=metrics, entry_debit_points=natural, mid_debit_points=mid,
                   contract_count=count, q0_mid_repricing_residual_usd=residual,
                   natural_minus_mid_cost_usd=spread_cost,
                   cost_stress_ev_usd=metrics['model_ev_net_usd'] - count * 100 *
                       (cfg['cost_stress_slippage_per_contract_points']-cfg['extra_slippage_per_contract_points']),
                   distribution_stress_ev_usd=stress,
                   displayed_group_limit=min(int(chain[(l['strike'], l['right'])]['ask_size' if l['qty'] > 0 else 'bid_size']) // abs(l['qty']) for l in legs),
                   expiry_funding_reserve_usd=metrics['max_loss_net_usd'],
                   entry_quotes=[{**l, **{k: chain[(l['strike'], l['right'])][k]
                                            for k in ('bid', 'ask', 'bid_size', 'ask_size')}} for l in legs])
        records.append(row)
    return records


def black_price(forward, vol, strike, right, discount):
    """Separate Black formula used solely to generate synthetic control prices."""
    n = NormalDist()
    d1 = math.log(forward/strike)/vol + vol/2
    d2 = d1-vol
    return discount * (forward*n.cdf(d1)-strike*n.cdf(d2) if right == 'call'
                       else strike*n.cdf(-d2)-forward*n.cdf(-d1))


def negative_control(cfg):
    rows = []
    for vol in (.006, .015):
        for discount in (1., .997):
            distribution = Lognormal(7500., vol, 'synthetic_known_Q')
            prediction = {'median': distribution.quantile(.5),
                          'bands': {label: [distribution.quantile((1-float(label)/100)/2),
                                            distribution.quantile((1+float(label)/100)/2)] for label in ('68', '95')}}
            for name, legs in candidates(prediction, cfg).items():
                mids = [black_price(7500., vol, l['strike'], l['right'], discount) for l in legs]
                mid = sum(l['qty']*p for l, p in zip(legs, mids))
                contracts = sum(abs(l['qty']) for l in legs)
                # Symmetric positive spreads; each trade pays 0.01 point adverse to mid.
                natural = mid + .01*contracts
                zero = pnl_metrics(legs, distribution, mid, fee=0, discount=discount)
                paid = pnl_metrics(legs, distribution, natural, fee=1.5, discount=discount)
                expected_cost = contracts * 2.5
                assert abs(zero['model_ev_net_usd']) < 2e-7
                assert abs(paid['model_ev_net_usd'] + expected_cost) < 2e-7
                rows.append({'vol': vol, 'discount': discount, 'candidate': name,
                             'mid_zero_cost_ev': zero['model_ev_net_usd'],
                             'natural_fee_ev': paid['model_ev_net_usd'], 'expected_total_cost_usd': expected_cost})
    return {'cases': rows, 'case_count': len(rows), 'all_passed': True,
            'max_abs_zero_cost_ev_usd': max(abs(r['mid_zero_cost_ev']) for r in rows)}


def run(smoke=False):
    method = verify_method()
    cfg = plan()
    if cfg['discount_factor'] != 1:
        raise ValueError('Historical E01 expiry scoring currently requires discount factor 1')
    OUT.mkdir(parents=True, exist_ok=True)
    registration = OUT / 'registered-plan.json'
    if registration.exists():
        if json.loads(registration.read_text())['plan_sha256'] != sha(PLAN):
            raise ValueError('Experiment parameters changed; register another experiment')
    else:
        write_json(registration, {'registered_at': datetime.now(timezone.utc).isoformat(),
                                 'plan_sha256': sha(PLAN), 'plan': cfg,
                                 'note': 'Rules registered before E01 results, after prior exploration of these dates.'})
    archived = json.loads((FORECAST_OUT / 'evaluation.json').read_text())
    known = {(p['model'], p['target_date']): p for p in archived['predictions']}
    dates = sorted(archived['closes'])
    if smoke:
        dates = dates[:3]
    sources = {day: sha(ROOT / 'data/thetadata' / day / 'entry-snapshots-1000-1030-1100.parquet') for day in dates}
    inputs = {'method': method['method_file_sha256'], 'plan': sha(PLAN), 'code': sha(Path(__file__)),
              'density_code': sha(ROOT / 'services/theta/density.py'),
              'forecast_adapter_code': sha(ROOT / 'services/theta/forecast.py'),
              'replay_code': sha(ROOT / 'services/theta/replay.py'),
              'evaluation': sha(FORECAST_OUT / 'evaluation.json'), 'daily': sha(FORECAST_OUT / 'spx-daily.json'),
              'quotes': sources}
    name = 'smoke-results.json' if smoke else 'results.json'
    target = OUT / name
    if target.exists():
        cached = json.loads(target.read_text())
        if cached['input_hashes'] == inputs:
            print(json.dumps({'cache': 'hit', 'result': str(target), 'summary': cached['totals']}, ensure_ascii=False, indent=2))
            return cached
    control = negative_control(cfg)
    rows, distributions, failures = [], [], []
    for day in dates:
        rows.append({'date': day, 'candidate': 'no_trade', 'status': 'baseline', 'net_pnl_usd': 0.,
                     'decision': 'NO_TRADE_RESEARCH_ONLY'})
        try:
            chain, source = snapshot(day)
            prediction = option_prediction(day, chain, forecast_plan())
        except (ValueError, FileNotFoundError) as exc:
            failures.append({'date': day, 'reason': str(exc)})
            rows.extend({'date': day, 'candidate': c, 'status': 'skipped', 'reason': 'Forecast unavailable',
                         'decision': 'NO_TRADE_RESEARCH_ONLY'} for c in cfg['candidates'])
            continue
        previous = known[('option_implied', day)]
        assert all(previous[k] == value for k, value in prediction.items())
        assert previous['source'] == source
        distribution = Lognormal(prediction['forward'], prediction['total_log_volatility'])
        distributions.append({'date': day, 'source': source, 'measure': distribution.measure,
                              'forward': distribution.forward, 'total_vol': distribution.total_vol,
                              'quantiles': {str(p): distribution.quantile(p) for p in cfg['probability_levels']},
                              'median': distribution.quantile(.5), 'mode': distribution.forward*math.exp(-1.5*distribution.total_vol**2),
                              'mean': distribution.forward,
                              'cdf_grid': [{'spot': distribution.quantile(i/100), 'cdf': i/100} for i in range(1,100)]})
        rows.extend(analyze_day(day, prediction, chain, cfg))
    # Outcomes are attached only after every date's candidates and diagnostics exist.
    closes = {r['date']: r['close'] for r in daily_data()['rows']}
    for row in rows:
        if row['status'] != 'priced':
            continue
        spot = closes[row['date']]
        assert spot == archived['closes'][row['date']]
        m = row['metrics']
        pnl = terminal_payoff(row['legs'], spot) - m['signed_entry_debit_usd'] - m['opening_fees_usd'] - m['extra_slippage_usd']
        assert m['net_pnl_min_usd']-1e-6 <= pnl <= m['net_pnl_max_usd']+1e-6
        row['observed_close'] = spot
        row['observed_expiry_pnl_usd'] = pnl
    summaries = []
    for candidate in cfg['candidates']:
        eligible = [r for r in rows if r['candidate'] == candidate and r['status'] == 'priced']
        summary = {'candidate': candidate, 'priced': len(eligible), 'skipped': len(dates)-len(eligible)}
        if eligible:
            summary.update(mean_q0_ev_usd=mean(r['metrics']['model_ev_net_usd'] for r in eligible),
                           positive_q0_ev_days=sum(r['metrics']['model_ev_net_usd'] > 0 for r in eligible),
                           mean_q0_mid_residual_usd=mean(r['q0_mid_repricing_residual_usd'] for r in eligible),
                           mean_spread_fee_usd=mean(r['natural_minus_mid_cost_usd']+r['metrics']['opening_fees_usd'] for r in eligible),
                           median_max_loss_usd=median(r['metrics']['max_loss_net_usd'] for r in eligible),
                           worst_max_loss_usd=max(r['metrics']['max_loss_net_usd'] for r in eligible),
                           mean_cost_stress_ev_usd=mean(r['cost_stress_ev_usd'] for r in eligible),
                           observed_wins=sum(r['observed_expiry_pnl_usd'] > 0 for r in eligible),
                           observed_losses=sum(r['observed_expiry_pnl_usd'] < 0 for r in eligible),
                           positive_ev_sensitive_cases=sum(r['metrics']['model_ev_net_usd'] > 0 and
                               min(r['distribution_stress_ev_usd'].values()) <= 0 for r in eligible),
                           observed_expiry_pnl_sum_usd=sum(r['observed_expiry_pnl_usd'] for r in eligible))
        summaries.append(summary)
    priced = [r for r in rows if r['status'] == 'priced']
    result = {'created_at': datetime.now(timezone.utc).isoformat(), 'experiment': cfg, 'method': method,
              'input_hashes': inputs, 'negative_control': control, 'start': dates[0], 'end': dates[-1],
              'distributions': distributions, 'failures': failures, 'records': rows, 'summaries': summaries,
              'totals': {'sessions': len(dates), 'valid_forecasts': len(distributions), 'priced_candidates': len(priced),
                         'skipped_candidates': sum(r['status'] == 'skipped' for r in rows),
                         'positive_q0_residual_after_cost': sum(r['metrics']['model_ev_net_usd'] > 0 for r in priced),
                         'no_trade_baselines': len(dates), 'live_trade_signals': 0},
              'interpretation': 'All Q0 probabilities and EVs are model repricing diagnostics, not physical win probabilities or alpha. Observed expiry results are retrospective conditional quote cashflows; no selection or portfolio return.'}
    write_json(target, result)
    if not smoke:
        report(result)
    print(json.dumps({'cache': 'miss', 'result': str(target), 'totals': result['totals'],
                      'negative_control_cases': control['case_count'], 'summaries': summaries}, ensure_ascii=False, indent=2))
    return result


def report(result):
    lines = ['# PDE-E01：分布与组合期望盈亏最小验证', '',
             '**本轮验证分布与现金流是否自洽。Q₀ 下的正期望是简化模型与报价的差异，不是已证实的盈利优势。**', '',
             'Q₀ 是从期权报价反推的简化价格分布；EV 是在该分布下把各个结果按概率加权后的平均净盈亏。它们尚不是对未来真实胜率和盈利的可靠估计。', '',
             f"日期：{result['start']} 至 {result['end']}。固定 SPXW 同日到期、美东 10:00、每个候选一组，持有到期。", '',
             '## 合成行情负对照', '',
             f"{result['negative_control']['case_count']} 个合成情景全部通过：同一已知 Q 的模型价格与积分相符；最大零成本残差 ${result['negative_control']['max_abs_zero_cost_ev_usd']:.10f}。",
             '包含两个波动水平、两个折现因子与七种候选。加入每张 $1 价差成本及 $1.50 开仓费后，四张组合 EV = -$10，两张价差 EV = -$5。', '',
             '## 历史输入与拒绝记录', '',
             f"{result['totals']['sessions']} 个日期、{result['totals']['valid_forecasts']} 个有效分布、{result['totals']['priced_candidates']} 个可计价候选、{result['totals']['skipped_candidates']} 个拒绝候选。另保留每天不交易基准。",
             '模型拒绝：' + '；'.join(f"{x['date']}：{x['reason']}" for x in result['failures']) + '。', '',
             '其他候选拒绝：' + '；'.join(f"{r['date']} / {LABELS[r['candidate']]}：{r['reason']}" for r in result['records']
                                                 if r['status']=='skipped' and r['reason']!='Forecast unavailable') + '。', '',
             '## 固定候选汇总（每次一组，美元）', '',
             '| 候选 | 可计价/跳过 | 盈利/亏损笔数 | 平均 Q₀ 净EV | 平均价差+费用 | 最大亏损中位数 | 实际收盘条件损益合计 |',
             '|---|---:|---:|---:|---:|---:|---:|']
    for s in result['summaries']:
        if s['priced']:
            lines.append(f"| {LABELS[s['candidate']]} | {s['priced']}/{s['skipped']} | {s['observed_wins']}/{s['observed_losses']} | {s['mean_q0_ev_usd']:.2f} | {s['mean_spread_fee_usd']:.2f} | {s['median_max_loss_usd']:.2f} | {s['observed_expiry_pnl_sum_usd']:.2f} |")
        else:
            lines.append(f"| {LABELS[s['candidate']]} | 0/{s['skipped']} | — | — | — | — | — |")
    lines += ['', '各行是独立固定候选序列，不同组合相互重叠，不能相加当成账户收益；右列仅用真实收盘核对报价假设下现金流，没有据此挑选当天赢家。', '',
              '以上区间均来自我们冻结的 v1 模型，不使用博主区间。68% / 95% 是原分布区间标签，不等于对应组合的实际胜率。模型 EV 是假设分布的平均值，实际样本损益是已经发生的一条路径；两者符号不同不构成算术矛盾。', '',
              f"共有 {result['totals']['positive_q0_residual_after_cost']} 个候选出现正 Q₀ 净EV，其中 {sum(s.get('positive_ev_sensitive_cases',0) for s in result['summaries'])} 个在至少一个预先指定的中心/波动压力情景下变为非正。正残差对假设敏感，不能据此挑选实盘组合。", '',
              '## 如何解释模型 EV', '',
              '```text', 'Q₀ 净EV = Q₀ 对中间价的重定价差异 − natural相对mid的价差成本 − 开仓费用 − 额外滑点', '```', '',
              '买 ask、卖 bid 已包含价差，不重复扣除。每张开仓费用 $1.50 是研究假设，不是券商费用报价；本轮未计额外行权/结算收费。每张额外 0.02 点（$2）的成本压力结果另存 JSON。',
              'Q₀ 只由平值附近报价反推单一波动，不完整反映偏斜、跳跃及跨行权价曲率。它可能给同一条链中的部分结构算出正残差；当前均保留 NO_TRADE_RESEARCH_ONLY。', '',
              '## 每笔已经输出的指标', '',
              '- CDF 网格、分位数、均值、中位数与众数；任意价格区间概率由 density.py 查询。',
              '- 最大净亏损、最大净利润、净盈亏平衡点、Q₀ 胜/负/持平概率、平台型最差和最好结果的概率。',
              '- Q₀ 预期盈利、预期亏损、亏损条件下的平均金额，以及最差 5% 情况的平均损益。',
              '- 波动缩放至 80%/120%、中心上下移动四分之一原波动的 EV 敏感性。这些是人为压力情景，不是置信区间或真实概率模型。',
              '- 逐腿报价、数量、文件哈希、方法与实验版本；净最大亏损作为研究资金准备值，不是 IBKR 保证金承诺。', '',
              '## 验证边界与下一步', '',
              '当前只对完整组合持有到期建模；终值分布不预测盘中止盈止损、盘中最大回撤或实际组合成交。分钟快照不能证明原始报价新鲜或多腿同时成交。',
              '历史现金流用缓存的 SPX 日收盘近似 SPXW PM 结算值，尚未逐日核对官方结算记录；报告数字属于这个报价与结算代理假设下的复盘。',
              '尚未建立经验证的现实概率 P；样本已经查看过，不能将它作为独立样本外盈利证明。下一阶段优先补齐更长的同一预测时点历史，研究有符号误差分布和尾部校准，再决定是否启用交易选择。', '',
              '## 复现', '', '```bash', 'npm run theta:pde -- smoke', 'npm run theta:pde -- run',
              '.cache/thetadata-venv/bin/python services/theta/audit_pde.py', '```', '',
              '`results.json` 包含全部记录；`registered-plan.json` 保存实验规则；`audit.json` 保存独立现金流与数值积分核对。输入/代码哈希相同会复用结果。本轮仅用本地缓存，没有新采购、行情下载或订单。', '']
    (OUT/'report.md').write_text('\n'.join(lines))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['smoke', 'run'])
    args = parser.parse_args()
    run(smoke=args.action == 'smoke')
