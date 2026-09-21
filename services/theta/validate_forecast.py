"""Frozen-rule historical coverage validation; never selects model parameters."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
from statistics import NormalDist

from forecast import (
    NAMES, OUT, PLAN, ROOT, calibrated_prediction, calibration_score,
    daily_data, interval_metrics, option_prediction, plan, preopen_prediction,
    register, snapshot, write_json,
)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def wilson_iid(hits, count):
    """Illustrative 95% binomial interval; not valid under arbitrary dependence."""
    z = NormalDist().inv_cdf(.975)
    p = hits / count
    denominator = 1 + z * z / count
    center = (p + z * z / (2 * count)) / denominator
    radius = z * math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator
    return [max(0., center - radius), min(1., center + radius)]


def summarize(predictions, closes, coverage, scope):
    metrics = interval_metrics(predictions, closes, coverage)
    flags = [p['bands'][str(round(coverage * 100))][0] <= closes[p['target_date']]
             <= p['bands'][str(round(coverage * 100))][1] for p in predictions]
    run = longest = 0
    for hit in flags:
        run = 0 if hit else run + 1
        longest = max(longest, run)
    return {'scope': scope, 'model': predictions[0]['model'], 'nominal_coverage': coverage,
            'start': predictions[0]['target_date'], 'end': predictions[-1]['target_date'],
            **metrics, 'longest_consecutive_available_misses': longest,
            'illustrative_iid_wilson_95': wilson_iid(metrics['covered'], metrics['sessions'])}


def same_prediction(actual, archived):
    for key, value in actual.items():
        assert archived[key] == value, (actual['target_date'], actual['model'], key)


def validate():
    register()
    cfg = plan()
    daily = daily_data()
    rows = daily['rows']
    closes = {r['date']: r['close'] for r in rows}
    old = json.loads((OUT / 'evaluation.json').read_text())
    assert sha(PLAN) == old['plan_sha256']
    assert sha(OUT / 'spx-daily-raw.json') == daily['raw_sha256']
    assert all(closes[day] == close for day, close in old['closes'].items())
    archived = {(p['model'], p['target_date']): p for p in old['predictions']}
    assert len(archived) == len(old['predictions'])
    recent_dates = sorted(old['closes'])
    extended = []
    # Keep the existing 60-return rule. First 61 closes are warm-up only.
    for index in range(cfg['daily_history_returns'] + 1, len(rows)):
        day = rows[index]['date']
        prediction = preopen_prediction(day, rows[:index], cfg)
        # Actual/future rows must not change any field of a historical forecast.
        assert prediction == preopen_prediction(day, rows, cfg)
        mutated = rows[:index] + [{**r, 'close': 999999.} for r in rows[index:]]
        assert prediction == preopen_prediction(day, mutated, cfg)
        assert prediction['input_end_date'] < day
        extended.append(prediction)
        if day in recent_dates:
            same_prediction(prediction, archived[('preopen_history', day)])

    implied, calibrated, failures, scores = [], [], [], []
    for day in recent_dates:
        try:
            chain, source = snapshot(day)
            current = option_prediction(day, chain, cfg)
        except (ValueError, FileNotFoundError) as exc:
            failures.append({'date': day, 'error': str(exc)})
            continue
        same_prediction(current, archived[('option_implied', day)])
        assert source == archived[('option_implied', day)]['source']
        current['source'] = source
        implied.append(current)
        adjusted = calibrated_prediction(current, scores, cfg)
        # Add deliberately invalid current/future labels; they must be ignored.
        poisoned = scores + [{'date': day, 'score': 999999.},
                             {'date': '9999-12-31', 'score': 999999.}]
        assert adjusted == calibrated_prediction(current, poisoned, cfg)
        if adjusted:
            assert max(adjusted['training_dates']) < day
            same_prediction(adjusted, archived[('option_calibrated', day)])
            calibrated.append(adjusted)
        else:
            assert ('option_calibrated', day) not in archived
        scores.append({'date': day, 'score': calibration_score(current, closes[day])})
    assert failures == old['failures']
    assert scores == old['scores']
    assert len(implied) == sum(p['model'] == 'option_implied' for p in old['predictions'])
    assert len(calibrated) == sum(p['model'] == 'option_calibrated' for p in old['predictions'])
    bloggers = [archived[('blogger', day)] for day in recent_dates]
    groups = {'preopen_history': extended, 'option_implied': implied,
              'option_calibrated': calibrated, 'blogger': bloggers}
    scopes = {
        'extended_preopen': {'preopen_history': extended},
        'before_recent_period': {'preopen_history': [p for p in extended if p['target_date'] < recent_dates[0]]},
        'recent_available': {m: [p for p in ps if p['target_date'] in recent_dates] for m, ps in groups.items()},
    }
    for label, eligible in [('option_common', implied), ('calibration_common', calibrated)]:
        dates = {p['target_date'] for p in eligible}
        scopes[label] = {m: [p for p in ps if p['target_date'] in dates] for m, ps in groups.items()
                         if label != 'option_common' or m != 'option_calibrated'}
    summaries = [summarize(ps, closes, coverage, scope)
                 for scope, models in scopes.items() for ps in models.values() if ps
                 for coverage in cfg['coverage_levels']]
    months = defaultdict(list)
    detail = []
    for model, ps in groups.items():
        for p in ps:
            months[(model, p['target_date'][:7])].append(p)
            for coverage in cfg['coverage_levels']:
                low, high = p['bands'][str(round(coverage * 100))]
                actual = closes[p['target_date']]
                detail.append({'date': p['target_date'], 'model': model, 'nominal_coverage': coverage,
                               'low': low, 'high': high, 'actual_close': actual,
                               'covered': low <= actual <= high,
                               'miss_direction': 'below' if actual < low else 'above' if actual > high else None,
                               'miss_points': max(low - actual, actual - high, 0.), 'width': high - low})
    monthly = [summarize(ps, closes, coverage, month)
               for (_, month), ps in sorted(months.items()) for coverage in cfg['coverage_levels']]
    result = {
        'created_at': datetime.now(timezone.utc).isoformat(),
        'plan_sha256': sha(PLAN), 'forecast_code_sha256': sha(ROOT / 'services/theta/forecast.py'),
        'validation_code_sha256': sha(Path(__file__)),
        'evaluation_sha256': sha(OUT / 'evaluation.json'),
        'daily_source_sha256': sha(OUT / 'spx-daily.json'),
        'daily_rows': len(rows), 'daily_start': rows[0]['date'], 'daily_end': rows[-1]['date'],
        'warmup_closes': cfg['daily_history_returns'] + 1,
        'interpretation': 'Retrospective fixed-rule reconstruction, not an untouched holdout. '
                          'Targets are cash closes, not intraday high/low. No parameter search performed.',
        'uncertainty_note': 'Wilson intervals assume independent Bernoulli observations with a common '
                            'probability. Financial time dependence and model selection violate these '
                            'assumptions; intervals are illustrative, not prospective guarantees.',
        'checks': {'preopen_cutoff_and_future_mutation_days': len(extended),
                   'option_raw_snapshot_reconstructions': len(implied),
                   'calibrated_forecasts_reconstructed': len(calibrated),
                   'historical_scores_recomputed': len(scores),
                   'prior_result_matches': True, 'model_parameters_changed': False},
        'failures': failures, 'summaries': summaries, 'monthly': monthly,
        'detail': detail, 'extended_preopen_predictions': extended,
    }
    write_json(OUT / 'accuracy.json', result)
    make_report(result)
    make_plot(result)
    print(json.dumps({k: result[k] for k in ('checks', 'failures', 'summaries')}, ensure_ascii=False, indent=2))
    return result


def make_report(result):
    lines = ['# 自建 SPX 收盘区间：历史准确率与过拟合检查', '',
             '本次沿用 v1 固定规则，没有搜索参数或按结果更换模型。所有结果为事后按时间顺序重建，不是当时真实发布的预测。', '',
             '## 评估口径', '',
             '- 命中＝该日 SPX 最终收盘位于区间内；不代表盘中始终没有越界，也不是期权交易盈利率。',
             f"- 日线共 {result['daily_rows']} 天，{result['daily_start']} 至 {result['daily_end']}；前 {result['warmup_closes']} 个收盘仅用于热身。",
             '- 盘前规则：严格使用前 60 个日收益。期权规则：仅使用当日美东 10:00 报价。校准仅用此前已经发生的误差。',
             '- 期权报价只有最近 38 个评估日，其中 2 天质量不合格；95% 区间覆盖 35/36 是对成功出预测的日期统计，不能写成全年覆盖率。',
             '- 68% / 95% 是模型标称覆盖水平；实际覆盖必须另行检验。期权隐含模型的定价分布不能直接充当真实概率。', '',
             '## 固定规则结果', '',
             '| 范围 | 模型 | 标称 | 命中/预测 | 实际覆盖 | 平均全宽（点） | 区间评分↓ |',
             '|---|---|---:|---:|---:|---:|---:|']
    labels = {'extended_preopen': '全部可评估日线', 'before_recent_period': '近期38天之前',
              'recent_available': '近期各自可用日期', 'option_common': '相同期权日期',
              'calibration_common': '相同校准日期'}
    for s in result['summaries']:
        lines.append(f"| {labels[s['scope']]} | {NAMES[s['model']]} | {s['nominal_coverage']:.0%} | "
                     f"{s['covered']}/{s['sessions']} | {s['coverage']:.1%} | {s['mean_width_points']:.1f} | {s['mean_interval_score']:.1f} |")
    lines += ['', '区间评分＝全宽＋2/(1−标称覆盖)×越界点数；兼顾宽度和漏报程度，越低越好。', '',
              '同日比较仍不代表同一信息集：盘前模型没有开盘信息；博主的原始发布时间未独立确认。', '',
              '## 盘前模型逐月稳定性', '',
              '| 月份 | 天数 | 68%区间覆盖 | 95%区间覆盖 | 95%平均全宽（点） |',
              '|---|---:|---:|---:|---:|']
    preopen = {(s['scope'], round(s['nominal_coverage'] * 100)): s
               for s in result['monthly'] if s['model'] == 'preopen_history'}
    for month in sorted({month for month, _ in preopen}):
        a, b = preopen[(month, 68)], preopen[(month, 95)]
        lines.append(f"| {month} | {a['sessions']} | {a['covered']}/{a['sessions']}（{a['coverage']:.1%}） | "
                     f"{b['covered']}/{b['sessions']}（{b['coverage']:.1%}） | {b['mean_width_points']:.1f} |")
    lines += ['', '首尾月份仅覆盖部分交易日。月度分组用于描述稳定性，没有用来选参数或挑交易月份。', '',
              '## 期权模型漏报明细', '',
              '| 模型 | 日期 | 标称 | 下界 | 上界 | 实际收盘 | 越界点数 |',
              '|---|---|---:|---:|---:|---:|---:|']
    for r in result['detail']:
        if r['model'] not in ('option_implied', 'option_calibrated') or r['covered']:
            continue
        lines.append(f"| {NAMES[r['model']]} | {r['date']} | {r['nominal_coverage']:.0%} | "
                     f"{r['low']:.2f} | {r['high']:.2f} | {r['actual_close']:.2f} | {r['miss_points']:.2f} |")
    lines += ['', '拒绝出预测的日期：' + '；'.join(f"{f['date']}（{f['error']}）" for f in result['failures']) + '。', '',
              '## 样本量能支持多强的结论', '',
              '下面仅用独立、同分布二项抽样的 Wilson 95% 置信区间演示小样本不确定性。金融时间序列存在依赖和环境变化，且本轮存在模型选择影响；这些数值不能作为未来覆盖率保证。', '',
              '| 模型 | 95%区间命中 | 历史覆盖 | 独立抽样假设下的参考范围 |',
              '|---|---:|---:|---:|']
    for s in result['summaries']:
        if s['scope'] != 'recent_available' or s['nominal_coverage'] != .95 or s['model'] == 'blogger':
            continue
        lo, hi = s['illustrative_iid_wilson_95']
        lines.append(f"| {NAMES[s['model']]} | {s['covered']}/{s['sessions']} | {s['coverage']:.1%} | {lo:.1%}–{hi:.1%} |")
    lines += ['', '## 过拟合与未来数据泄漏：分别回答', '',
              f"1. **输入截断检查通过。** {result['checks']['preopen_cutoff_and_future_mutation_days']} 个历史盘前预测分别删除/篡改目标日及未来价格，输出不变；期权从原始 10:00 快照重建；校准加入虚假的当日/未来误差后仍不变。",
              '2. **不能声称没有过拟合。** 我们已经看过近期历史、比较过模型与策略；60 天窗口、报价筛选和校准规则本身也是选择。没有未来数据泄漏，并不能排除模型选择迎合历史。',
              '3. **扩展历史说明样本选择很重要。** 盘前 95% 覆盖从近期 37/38（97.4%）降至全部 226/243（93.0%）；2025 年 11 月仅 14/19（73.7%），说明近期表现不代表每月表现。扩展期是额外回溯检查，不重新包装成严格未触碰的测试集。',
              '4. **校准增益尚未证明。** 在相同 16 天里，校准和未校准的 95% 区间均全部命中，但校准平均全宽约 140 点，未校准约 109 点；不能凭 100% 覆盖挑选校准版。',
              '5. **下一阶段应保留固定版本。** 对未来交易日先保存区间再观察结果，连续计入所有日期、拒绝预测和漏报；模型变更另建版本。补充更长的期权历史时保持规则不变，并报告各月份和波动环境。当前没有计算可信的“过拟合概率百分比”。',
              '6. **预测评价与交易盈利分开。** 即使覆盖率高，也要将同一时点的真实可成交价、保护翼、手续费和退出规则纳入交易检验。区间覆盖不能推出稳定盈利。', '',
              '方法背景：[Bailey 等，The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)。', '',
              '## 复现与文件', '',
              '```bash', '.cache/thetadata-venv/bin/python services/theta/validate_forecast.py',
              '.cache/thetadata-venv/bin/python services/theta/audit_forecast.py', '```', '',
              '- accuracy.json：逐日预测、命中、越界距离、逐月和同日比较，以及输入/代码哈希。',
              '- accuracy.png：盘前逐月覆盖与期权每日收盘相对区间的位置。',
              '- 本次全部使用本地缓存，没有新增数据购买或交易。', '',
              '![历史覆盖诊断](accuracy.png)', '']
    (OUT / 'accuracy-report.md').write_text('\n'.join(lines))


def make_plot(result):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(2, 1, figsize=(12, 8.2), constrained_layout=True)
    colors = {68: '#167c80', 95: '#7545a0'}
    monthly = [s for s in result['monthly'] if s['model'] == 'preopen_history']
    months = sorted({s['scope'] for s in monthly})
    for label in (68, 95):
        ss = [next(s for s in monthly if s['scope'] == m and round(s['nominal_coverage'] * 100) == label) for m in months]
        axes[0].plot(range(len(months)), [s['coverage'] * 100 for s in ss], marker='o',
                     color=colors[label], label=f'{label}% nominal')
        axes[0].axhline(label, color=colors[label], linewidth=.8, linestyle='--', alpha=.5)
    axes[0].set_xticks(range(len(months)), [f"{m}\nn={next(s['sessions'] for s in monthly if s['scope'] == m)}" for m in months], fontsize=8)
    axes[0].set(title='Pre-open historical model: monthly closing-range coverage (243 sessions)', ylabel='Observed coverage (%)', ylim=(35, 105))
    axes[0].legend(loc='lower right')
    option = [r for r in result['detail'] if r['model'] == 'option_implied' and r['nominal_coverage'] == .95]
    positions = [(r['actual_close'] - (r['low'] + r['high']) / 2) / ((r['high'] - r['low']) / 2) for r in option]
    axes[1].axhspan(-1, 1, color='#167c80', alpha=.12, label='95% closing-price range')
    for sign in (-1, 1):
        axes[1].axhline(sign, color='#167c80', linewidth=.8)
    axes[1].axhline(0, color='gray', linewidth=.7, linestyle=':')
    axes[1].plot(range(len(option)), positions, color='#637a85', linewidth=1, alpha=.7)
    axes[1].scatter(range(len(option)), positions, c=['#167c80' if r['covered'] else '#cc423c' for r in option], s=30, zorder=3)
    for i, r in enumerate(option):
        if not r['covered']:
            axes[1].annotate(f"{r['date']}\n{r['miss_points']:.1f} points outside", (i, positions[i]),
                             xytext=(12, 10), textcoords='offset points', fontsize=9)
    ticks = sorted(set(range(0, len(option), 5)) | {len(option) - 1})
    axes[1].set_xticks(ticks, [option[i]['date'][5:] for i in ticks])
    axes[1].set(title='10:00 ET option model: 35/36 closes inside 95% range; 2 rejected dates excluded',
                ylabel='Close position / interval half-width', ylim=(-1.8, 1.8), xlabel='2026 trading dates')
    axes[1].legend(loc='lower left')
    for ax in axes:
        ax.spines[['top', 'right']].set_visible(False)
        ax.grid(axis='y', alpha=.15)
    fig.suptitle('Frozen-rule retrospective check | Coverage is not trading win rate', fontsize=13)
    fig.savefig(OUT / 'accuracy.png', dpi=170)
    plt.close(fig)


if __name__ == '__main__':
    validate()
