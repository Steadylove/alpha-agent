"""Quote-implied terminal loss tails, not a forecast of physical win rates.

Uses only the selected entry-minute snapshot. Convex local option-price fits
and finite strike differences estimate risk-neutral tail probabilities.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
import polars as pl
from scipy.optimize import Bounds, LinearConstraint, minimize

from provider import ROOT


def fit_prices(rows: list[dict], right: str, low: float, high: float):
    data = sorted((q for q in rows if q['right'].lower() == right
                   and low <= q['strike'] <= high
                   and 0 <= q['bid'] <= q['ask'] and q['ask'] > 0
                   and q['ask'] - q['bid'] <= .5), key=lambda q: q['strike'])
    strikes = np.array([q['strike'] for q in data], dtype=float)
    mid = np.array([(q['bid'] + q['ask']) / 2 for q in data])
    scale = np.array([max(.05, q['ask'] - q['bid']) for q in data])
    if len(strikes) < 8:
        raise ValueError('Not enough valid strikes for a local probability estimate')
    diff = np.zeros((len(strikes) - 1, len(strikes)))
    for i, gap in enumerate(np.diff(strikes)):
        diff[i, i:i+2] = [-1 / gap, 1 / gap]
    convex = np.diff(diff, axis=0)
    constraints = [LinearConstraint(diff, 0 if right == 'put' else -1,
                                    1 if right == 'put' else 0),
                   LinearConstraint(convex, 0, np.inf)]
    result = minimize(lambda x: np.sum(((x - mid) / scale)**2), mid,
                      jac=lambda x: 2 * (x - mid) / scale**2,
                      bounds=Bounds(0, np.inf), constraints=constraints,
                      method='SLSQP', options={'maxiter': 1000, 'ftol': 1e-10})
    if not result.success:
        raise ValueError(f'Convex fit failed: {result.message}')
    slopes = diff @ result.x
    if np.min(np.diff(slopes)) < -1e-7:
        raise ValueError('Fitted option prices violate convexity')
    details = [{**q, 'mid': float(m), 'fitted': float(f)}
               for q, m, f in zip(data, mid, result.x)]
    return strikes, result.x, details


def tail_probability(fit, strike, radius, right):
    k, prices, _ = fit
    strike = np.asarray(strike)
    if np.any(strike - radius < k[0]) or np.any(strike + radius > k[-1]):
        raise ValueError('Requested probability would require extrapolation')
    slope = (np.interp(strike + radius, k, prices) - np.interp(strike - radius, k, prices)) / (2 * radius)
    return np.clip(slope if right == 'put' else -slope, 0, 1)


def estimate(day='2026-09-14'):
    out = ROOT / 'data/thetadata' / day
    replay = json.loads((out / 'replay.json').read_text())
    trade = next(s for s in replay['scenarios'] if s['band']=='95' and s['width']==10
                 and s['entry_time_et']=='10:00' and s['pricing']=='natural')
    rows = pl.read_parquet(out / 'quotes.parquet').filter(
        pl.col('timestamp').dt.strftime('%H:%M:%S') == '10:00:00').to_dicts()
    sp = trade['legs'][1]['strike']
    sc = trade['legs'][2]['strike']
    put = fit_prices(rows, 'put', sp - 70, sp + 50)
    call = fit_prices(rows, 'call', sc - 60, sc + 70)
    profit = trade['max_profit_net_usd']
    maximum = trade['max_loss_net_usd']
    amounts = np.unique(np.r_[np.linspace(0, maximum, 301), 100, 200, 500, 800, 950])
    curves = {}
    for radius in (5, 10, 15):
        lower = sp - (profit + amounts) / 100
        upper = sc + (profit + amounts) / 100
        p = tail_probability(put, lower, radius, 'put') + tail_probability(call, upper, radius, 'call')
        if np.any(np.diff(p) > 1e-8) or np.any(p > 1):
            raise ValueError('Invalid non-monotone loss survival curve')
        curves[str(radius)] = p
    baseline = curves['10']
    tests = [0, 100, 200, 500, 800, 950, maximum]
    points = [{'loss_threshold_usd': x,
               'probability': float(np.interp(x, amounts, baseline)),
               'smoothing_low': float(min(np.interp(x, amounts, p) for p in curves.values())),
               'smoothing_high': float(max(np.interp(x, amounts, p) for p in curves.values())),
               'conditional_on_loss': float(np.interp(x, amounts, baseline) / baseline[0])}
              for x in tests]
    result = {
        'date': day, 'entry_time_et': '10:00', 'trade': {k: v for k, v in trade.items() if k != 'curve'},
        'interpretation': 'risk-neutral terminal probabilities implied by entry quotes; not actual win rates or intraday drawdown probabilities',
        'method': 'bid-ask-width weighted convex least-squares fits of local put/call mids; central strike differences; discount factor approximated as 1 for six hours',
        'baseline_difference_radius_points': 10, 'sensitivity_radii_points': [5, 10, 15],
        'sensitivity_note': 'Only sensitivity to smoothing bandwidth, NOT a statistical confidence interval; not full quote/model uncertainty.',
        'no_lookahead': 'Uses only 10:00 quotes and entry legs/credit/fees; no subsequent price path or final settlement is used to infer probabilities.',
        'profit_probability': float(1-baseline[0]), 'loss_probability': float(baseline[0]),
        'full_loss_probability': float(baseline[-1]),
        'partial_loss_probability': float(baseline[0]-baseline[-1]),
        'conditional_full_loss_probability': float(baseline[-1]/baseline[0]),
        'net_breakevens': [sp-profit/100, sc+profit/100], 'points': points,
        'curve': [{'loss_threshold_usd': float(x), **{f'radius_{h}': float(y[i]) for h, y in curves.items()}}
                  for i, x in enumerate(amounts)],
        'fits': {'put': put[2], 'call': call[2]},
        'sources': ['https://www.minneapolisfed.org/banking/current-and-historical-market-based-probabilities',
                    'https://www.federalreserve.gov/pubs/feds/2011/201145/index.html'],
    }
    (out/'loss-probability.json').write_text(json.dumps(result, ensure_ascii=False, indent=2, default=str)+'\n')
    plot(result, out)
    write_report(result, out)
    return result


def plot(r, out):
    os.environ.setdefault('MPLCONFIGDIR', str(ROOT/'.cache/matplotlib'))
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.font_manager import FontProperties
    from matplotlib.ticker import PercentFormatter
    font = FontProperties(fname='/System/Library/Fonts/STHeiti Light.ttc')
    plt.rcParams.update({'font.family': font.get_name(), 'axes.unicode_minus': False,
                         'font.size': 12, 'figure.facecolor': '#ffffff', 'axes.facecolor': '#ffffff'})
    # Explicit registration makes the Chinese font available to every text artist.
    from matplotlib import font_manager
    font_manager.fontManager.addfont(font.get_file())
    x = np.array([v['loss_threshold_usd'] for v in r['curve']])
    ys = np.array([[v[f'radius_{h}'] for v in r['curve']] for h in (5, 10, 15)])
    fig, ax = plt.subplots(figsize=(10.5, 6.4))
    fig.subplots_adjust(left=.105, right=.94, top=.77, bottom=.20)
    fig.text(.105, .94, '这笔铁秃鹰：到期亏损金额与概率', fontsize=20, weight='bold')
    fig.text(.105, .885, 'SPXW 2026-09-14 · 美东 10:00 开仓 · 95% 预测区间 · 10 点保护翼', color='#46566a', fontsize=11)
    fig.text(.105, .828, f"报价隐含盈利概率约 {r['profit_probability']:.1%}    |    亏损概率约 {r['loss_probability']:.1%}    |    最大净亏损 $951", fontsize=12)
    ax.fill_between(x, ys.min(axis=0), ys.max(axis=0), color='#ccd9f3', alpha=.8, label='平滑参数敏感性（非置信区间）')
    ax.plot(x, ys[1], color='#2451a4', linewidth=2.6, label='市场报价隐含估计')
    for amount in (0, 500, 951):
        p = next(v['probability'] for v in r['points'] if v['loss_threshold_usd']==amount)
        ax.scatter([amount], [p], color='#2451a4', s=44, zorder=5)
        if amount == 0:
            label=f'发生亏损：{p:.1%}'
            offset=(12, -25)
            align='left'
        elif amount == 500:
            label=f'亏损 ≥ $500：{p:.1%}'
            offset=(0, 15)
            align='center'
        else:
            label=f'亏满 $951：{p:.1%}'
            offset=(-10, -25)
            align='right'
        ax.annotate(label,(amount,p),xytext=offset,textcoords='offset points',ha=align,fontsize=11)
    ax.set(xlim=(-20,980), ylim=(0,.12), xlabel='到期净亏损门槛（美元 / 每组）', ylabel='亏损达到该金额的概率')
    ax.set_xticks([0,200,400,600,800,951])
    ax.yaxis.set_major_formatter(PercentFormatter(1, decimals=0))
    ax.grid(axis='y', color='#e1e6ed', linewidth=.8)
    ax.spines[['top','right']].set_visible(False)
    ax.legend(loc='upper right',frameon=False,fontsize=10)
    fig.text(.105,.09,'风险中性概率：包含风险定价，并非已验证的真实胜率。只描述持有到期损益，不描述盘中浮亏。',fontsize=10,color='#46566a')
    fig.text(.105,.045,'到期净收益上限 $49；费用假设 $6。亏损不可能超过 $951，因此超过此金额的概率为 0。',fontsize=10,color='#46566a')
    fig.savefig(out/'loss-probability.png', dpi=180)
    plt.close(fig)


def write_report(r, out):
    lines = ['# SPXW 到期亏损概率估计：2026-09-14', '',
             '**这是开仓报价隐含的风险中性概率，不是已经验证的实际胜率。**', '',
             '交易：美东 10:00；买入 7560P、卖出 7570P、卖出 7715C、买入 7725C；每腿一张。',
             '开仓净收 $55；开仓费假设 $6；最大净盈利 $49、最大净亏损 $951。',
             f"净盈利区间：{r['net_breakevens'][0]:.2f}–{r['net_breakevens'][1]:.2f}。", '',
             f"- 盈利概率估计：{r['profit_probability']:.2%}。",
             f"- 亏损概率估计：{r['loss_probability']:.2%}。",
             f"- 亏满 $951 的概率估计：{r['full_loss_probability']:.2%}。",
             f"- 条件于发生亏损，亏满的概率估计：{r['conditional_full_loss_probability']:.2%}。", '',
             '| 到期亏损门槛 | 无条件尾部概率 | 平滑敏感性范围 | 已发生亏损条件下 |',
             '|---|---:|---:|---:|']
    for p in r['points']:
        lines.append(f"| ${p['loss_threshold_usd']:g} | {p['probability']:.2%} | {p['smoothing_low']:.2%}–{p['smoothing_high']:.2%} | {p['conditional_on_loss']:.2%} |")
    lines += ['', '0 表示发生净亏损；其余门槛表示到期净亏损至少达到该金额。满亏为有概率质量的结果，$951 以上尾部概率立即为 0。', '',
              '## 方法与限制', '',
              '- 仅使用 10:00 当时的期权链、开仓权利金和预设费用。未使用实际收盘或后续走势估计概率。',
              '- 对看跌/看涨期权中间价分别做受单调性与凸性约束的加权最小二乘拟合，权重来自买卖价差。',
              '- 看跌价对行权价的导数对应风险中性左尾概率；看涨价负导数对应右尾概率。两侧尾部相加得到组合亏损概率。',
              '- 以左右各 10 点的中心差分为基准，左右各 5 / 15 点展示平滑敏感性。该范围不是统计置信区间，也未涵盖所有盘口与模型不确定性。',
              '- 六小时折现因子近似为 1；未校准风险溢价，因此不能把上述数字当成真实世界胜率或真实期望收益。',
              '- 只描述到期损益，无法推断盘中止损/回撤触发概率。',
              '- 模型用中间价反推概率；实际开仓损益仍沿用卖 bid / 买 ask 的 $55 信用。', '',
              '[市场隐含概率说明](https://www.minneapolisfed.org/banking/current-and-historical-market-based-probabilities)',
              '[期权价格导数与风险中性分布](https://www.federalreserve.gov/pubs/feds/2011/201145/index.html)', '']
    (out/'loss-probability.md').write_text('\n'.join(lines))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', default='2026-09-14')
    args = parser.parse_args()
    report = estimate(args.date)
    print(json.dumps({k: report[k] for k in ('profit_probability','loss_probability','full_loss_probability','points')}, indent=2))
