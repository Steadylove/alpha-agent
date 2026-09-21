"""PDE-E02: rolling P candidates, paired scores and a predeclared selection probe."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
from statistics import mean

import numpy as np

from calibration import fit_models, score_distribution, signed_residual
from density import pnl_metrics
from forecast import option_prediction, plan as forecast_plan, write_json
from method_lock import ROOT, verify_method
from pde import analyze_day, LABELS, plan as candidate_plan
from pde_history import OUT, PLAN, quote_path, read_chain, register, sha
from replay import settlement_pnl


def select_candidate(rows,probe):
    """Input has modeled metrics and entry quotes, no realized price/P&L."""
    eligible = []
    for row in rows:
        if row['status'] != 'priced':
            continue
        m = row['metrics']
        extra = row['contract_count']*100*probe['additional_slippage_per_contract_points']
        ev = m['model_ev_net_usd']-extra
        risk = m['max_loss_net_usd']+extra
        if ev>0 and 0<risk<=probe['maximum_loss_usd'] and m['net_pnl_max_usd']-extra>0:
            eligible.append((ev/risk,row,ev,risk))
    if not eligible:
        return {'candidate':'no_trade','status':'RESEARCH_ONLY','reason':'No candidate passes cost-adjusted EV and maximum-loss filters'}
    _,row,ev,risk = max(eligible,key=lambda value:value[0])
    return {'candidate':row['candidate'],'status':'RESEARCH_ONLY','modeled_stressed_ev_usd':ev,
            'stressed_max_loss_usd':risk,'modeled_p_profit':row['metrics']['p_profit'],
            'reason':'Highest positive stressed EV / maximum loss within fixed risk cap'}


def paired_block_interval(values,cfg):
    """Circular moving-block bootstrap, approximate dependence-aware interval."""
    values = np.asarray(values,dtype=float)
    n = len(values)
    if not n:
        return None
    rng = np.random.default_rng(cfg['seed'])
    length = cfg['block_length_sessions']
    starts = rng.integers(0,n,size=(cfg['replicates'],int(np.ceil(n/length))))
    indexes = ((starts[:,:,None]+np.arange(length))%n).reshape(cfg['replicates'],-1)[:,:n]
    means = values[indexes].mean(axis=1)
    return {'paired_days':n,'mean_difference':float(values.mean()),
            'approximate_95pct_interval':np.quantile(means,cfg['interval']).tolist(),
            'block_length_sessions':length,'replicates':cfg['replicates']}


def pnl_summary(rows):
    pnl = [r['observed_stressed_pnl_usd'] for r in rows]
    running = peak = drawdown = 0.
    for value in pnl:
        running += value
        peak = max(peak,running)
        drawdown = max(drawdown,peak-running)
    selected = [r for r in rows if r['candidate']!='no_trade']
    return {'days':len(rows),'trades':len(selected),'no_trade_days':len(rows)-len(selected),
            'wins':sum(r['observed_stressed_pnl_usd']>0 for r in selected),
            'losses':sum(r['observed_stressed_pnl_usd']<0 for r in selected),
            'net_pnl_usd':sum(pnl),'mean_daily_pnl_usd':mean(pnl) if pnl else None,
            'daily_settled_max_drawdown_usd':drawdown,'worst_day_usd':min(pnl) if pnl else None,
            'selected_structures':dict(Counter(r['candidate'] for r in selected))}


def summarize_forecasts(forecasts,model):
    rows = [r['models'][model]['scores'] for r in forecasts]
    result = {'days':len(rows),**{key:mean(r[key] for r in rows) for key in
              ('standardized_crps','brier_above_q0_median','brier_outside_q0_95')},
              'pit_histogram':np.histogram([r['pit'] for r in rows],bins=np.linspace(0,1,11))[0].tolist()}
    result['bands'] = {label:{'covered':sum(r['bands'][label]['covered'] for r in rows),
                    'coverage':mean(r['bands'][label]['covered'] for r in rows),
                    'mean_width_points':mean(r['bands'][label]['width_points'] for r in rows),
                    'mean_interval_score_points':mean(r['bands'][label]['interval_score_points'] for r in rows)}
                    for label in ('68','95')}
    return result


def run():
    cfg,registration = register()
    method = verify_method()
    days = registration['dates']
    paths = {day:quote_path(day) for day in days}
    missing = [day for day,path in paths.items() if not path.exists()]
    if missing:
        raise ValueError(f'Historical download incomplete: {len(missing)} days; run pde_history.py first')
    code_files = ['pde_calibrate.py','pde_history.py','calibration.py','density.py','pde.py','forecast.py','replay.py']
    inputs = {'plan_sha256':sha(PLAN),'daily_sha256':registration['daily_sha256'],
              'candidate_plan_sha256':registration['candidate_plan_sha256'],
              'method':method['method_file_sha256'],
              'code':{f:sha(ROOT/'services/theta'/f) for f in code_files},
              'quotes':{day:sha(path) for day,path in paths.items()}}
    target = OUT/'results.json'
    if target.exists():
        result = json.loads(target.read_text())
        if result['input_hashes']==inputs:
            print(json.dumps({'cache':'hit','totals':result['totals']},ensure_ascii=False,indent=2))
            return result
    closes = {r['date']:r['close'] for r in json.loads((OUT/'daily-input.json').read_text())['rows']}
    cplan = candidate_plan()
    residuals,forecasts,refusals,warmup,quotes,policies = [],[],[],[],[],[]
    for i,day in enumerate(days,1):
        try:
            chain,source = read_chain(day)
            implied = option_prediction(day,chain,forecast_plan())
        except ValueError as exc:
            refusals.append({'date':day,'reason':str(exc)})
            continue
        try:
            fitted = fit_models(day,residuals,cfg)
        except ValueError as exc:
            fitted = None
            refusals.append({'date':day,'reason':str(exc),'scope':'calibration'})
        if fitted is None:
            warmup.append(day)
        else:
            models,training = fitted
            row = {'date':day,'source':source,'implied':implied,'training':training,'models':{},
                   'sample_label':'previously_inspected_E01' if day>='2026-07-23' else 'newly_retrieved_retrospective'}
            base = analyze_day(day,implied,chain,cplan)
            # Freeze every modeled metric and selection before attaching outcomes.
            for name,model in models.items():
                distribution = model.price_distribution(implied['forward'],implied['total_log_volatility'])
                priced = []
                for candidate in base:
                    candidate = dict(candidate)
                    candidate['probability_model'] = name
                    candidate['distribution_measure'] = distribution.measure
                    if candidate['status']=='priced':
                        candidate['metrics'] = pnl_metrics(candidate['legs'],distribution,candidate['entry_debit_points'],
                            cplan['fee_per_contract_usd'],cplan['extra_slippage_per_contract_points'],
                            cplan['discount_factor'],cplan['tail_probability'])
                        if name=='Q0':
                            original = next(r for r in base if r['candidate']==candidate['candidate'])
                            assert abs(candidate['metrics']['model_ev_net_usd']-original['metrics']['model_ev_net_usd'])<1e-6
                        # E01's Q0-only stress/residual fields are not relabeled as P.
                        for key in ('q0_mid_repricing_residual_usd','cost_stress_ev_usd','distribution_stress_ev_usd'):
                            candidate.pop(key,None)
                    priced.append(candidate)
                decision = select_candidate(priced,cfg['economic_probe'])
                policies.append({'date':day,'probability_model':name,**decision})
                row['models'][name] = {'distribution':model.description()}
                quotes.extend(priced)
            actual_z = signed_residual(implied,closes[day])
            row['observed_close'] = closes[day]
            row['observed_z'] = actual_z
            for name,model in models.items():
                row['models'][name]['scores'] = score_distribution(model,actual_z,implied['forward'],
                                                    implied['total_log_volatility'],closes[day],cfg['coverage_levels'])
            forecasts.append(row)
        # This close becomes training data only for subsequent dates.
        residuals.append({'date':day,'z':signed_residual(implied,closes[day]),'forward':implied['forward'],
                          'total_vol':implied['total_log_volatility'],'close':closes[day],'source':source})
        if i%20==0:
            print(f'[{i}/{len(days)}] valid={len(residuals)}, paired_scored={len(forecasts)}, refused={len(refusals)}',flush=True)
    if not forecasts:
        raise ValueError('No post-warmup common dates available')
    keyed = {}
    for row in quotes:
        if row['status']!='priced':
            continue
        extra = row['contract_count']*100*cfg['economic_probe']['additional_slippage_per_contract_points']
        base = settlement_pnl(row['legs'],row['entry_debit_points'],closes[row['date']],cplan['fee_per_contract_usd'])
        row['observed_base_pnl_usd'] = base
        row['observed_stressed_pnl_usd'] = base-extra
        assert -row['metrics']['max_loss_net_usd']-extra-1e-6 <= base-extra <= row['metrics']['net_pnl_max_usd']-extra+1e-6
        keyed[(row['date'],row['probability_model'],row['candidate'])] = row
    for policy in policies:
        policy['observed_stressed_pnl_usd'] = (0. if policy['candidate']=='no_trade' else
            keyed[(policy['date'],policy['probability_model'],policy['candidate'])]['observed_stressed_pnl_usd'])
    fs = {name:summarize_forecasts(forecasts,name) for name in cfg['models']}
    ps = {name:pnl_summary([r for r in policies if r['probability_model']==name]) for name in cfg['models']}
    monthly = []
    for month in sorted({r['date'][:7] for r in forecasts}):
        for name in cfg['models']:
            subset = [r for r in forecasts if r['date'].startswith(month)]
            monthly.append({'month':month,'model':name,'forecast':summarize_forecasts(subset,name),
                            'policy':pnl_summary([r for r in policies if r['probability_model']==name and r['date'].startswith(month)])})
    bootstrap = {}
    daily_pnl = {(r['date'],r['probability_model']):r['observed_stressed_pnl_usd'] for r in policies}
    for name in cfg['models'][1:]:
        bootstrap[name] = {
            'crps_difference_vs_Q0':paired_block_interval([r['models'][name]['scores']['standardized_crps']-
                                                          r['models']['Q0']['scores']['standardized_crps'] for r in forecasts],cfg['bootstrap']),
            'daily_policy_pnl_difference_vs_Q0':paired_block_interval([daily_pnl[(r['date'],name)]-
                                                      daily_pnl[(r['date'],'Q0')] for r in forecasts],cfg['bootstrap'])}
    fixed_candidates = []
    for name in cfg['models']:
        for candidate in cplan['candidates']:
            subset = [r for r in quotes if r['probability_model']==name and r['candidate']==candidate and r['status']=='priced']
            fixed_candidates.append({'model':name,'candidate':candidate,**pnl_summary(subset)})
    result = {'created_at':datetime.now(timezone.utc).isoformat(),'experiment':cfg,'method':method,'input_hashes':inputs,
              'residual_history':residuals,'warmup_dates':warmup,'refusals':refusals,'forecasts':forecasts,
              'candidate_records':quotes,'policy_records':policies,'forecast_summaries':fs,'policy_summaries':ps,
              'monthly':monthly,'bootstrap':bootstrap,'fixed_candidate_summaries':fixed_candidates,
              'totals':{'requested_sessions':len(days),'valid_Q0_sessions':len(residuals),'common_scored_sessions':len(forecasts),
                        'warmup_sessions':len(warmup),'refusals':len(refusals),
                        'priced_model_candidate_records':len(keyed),'prospective_scored_sessions':0},
              'interpretation':'Chronological retrospective calibration and a fixed economic probe. P candidates remain unvalidated; no live orders or stable-return claim. All policies have identical candidate geometry and costs.'}
    write_json(target,result)
    report(result)
    print(json.dumps({'totals':result['totals'],'forecast':fs,'policy':ps,'bootstrap':bootstrap},ensure_ascii=False,indent=2))
    return result


def report(result):
    cfg = result['experiment']
    lines = ['# PDE-E02：更长历史、滚动概率校准与固定选仓检验','',
        '**这是已登记规则的历史研究。校准模型仍是现实概率候选，未验证未来盈利，也未生成实盘订单。**','',
        f"输入范围 {cfg['start_date']} 至 {cfg['end_date']}，每日美东 10:00 SPXW 同日到期链。{result['totals']['requested_sessions']} 天请求，{result['totals']['valid_Q0_sessions']} 天通过冻结 v1 的报价质量门槛，{len(result['warmup_dates'])} 天预热，最终 {len(result['forecasts'])} 天共同评估。",'',
        '## 方法与时间边界','',
        '- Q0：冻结的期权隐含对数正态参考。',
        '- P_normal：此前有符号标准化误差的样本均值、标准差。',
        '- P_kernel（预先指定主研究模型）：此前每个误差周围放置一个高斯核，等权混合，保留偏斜；带宽固定用 1.06×样本标准差×n^(-1/5)。',
        '- 至少 60、最多 120 个此前有效日；不剪裁异常值、不优化带宽。当天收盘只在当天预测与选择完成后加入后续训练。',
        '- 2026-07-23 起是以前已经查看的 E01 样本；更早部分是新获取的历史扩展，也不是事前留存的未来测试。跨日训练可以更新，但整个版本没有用收益调参。','',
        '## 同日期预测质量','',
        'CRPS 衡量整个分布与结果的距离（本表使用标准化误差单位），越低越好。区间评分同时惩罚宽度和越界；不能只看覆盖率。','',
        '| 模型 | 天数 | 标准化 CRPS | 68% 覆盖 | 95% 覆盖 | 95% 平均宽度 | 95% 区间评分 |',
        '|---|---:|---:|---:|---:|---:|---:|']
    for name,s in result['forecast_summaries'].items():
        lines.append(f"| {name} | {s['days']} | {s['standardized_crps']:.4f} | {s['bands']['68']['coverage']:.1%} | {s['bands']['95']['coverage']:.1%} | {s['bands']['95']['mean_width_points']:.2f} | {s['bands']['95']['mean_interval_score_points']:.2f} |")
    lines += ['','## 固定选仓规则的成本后结果','',
        '全部模型面对同一批基于 Q0 区间生成的 7 种结构。每个有效日最多一组；最大亏损（含压力成本）不超过 $1,000，压力成本后模型 EV 必须为正，按 EV/最大亏损取最高者，否则不交易。这个限额是研究过滤条件，不是个人仓位建议。',
        '买 ask、卖 bid；每张 $1.50 开仓费，再额外扣 $2 滑点压力成本。完整持有到期，用 SPX 日收盘近似 PM 结算，未逐日核验官方结算记录。','',
        '| 模型 | 开仓天数 | 不交易天数 | 盈/亏笔数 | 累计净损益 | 最差单日 | 每日结算最大回撤 |',
        '|---|---:|---:|---:|---:|---:|---:|']
    for name,s in result['policy_summaries'].items():
        lines.append(f"| {name} | {s['trades']} | {s['no_trade_days']} | {s['wins']}/{s['losses']} | ${s['net_pnl_usd']:.2f} | ${s['worst_day_usd']:.2f} | ${s['daily_settled_max_drawdown_usd']:.2f} |")
    lines += ['','三行是替代规则，不能相加成账户收益。每日结算回撤不包含盘中波动；最大单笔风险也不限制连续亏损的累计金额。','',
              '### 实际选中了哪些结构','',
              '| 模型 | 选中结构与次数 |', '|---|---|']
    for name,s in result['policy_summaries'].items():
        selected = '；'.join(f'{LABELS[k]}：{v} 次' for k,v in s['selected_structures'].items()) or '无交易'
        lines.append(f'| {name} | {selected} |')
    lines += ['','这些选仓主要集中于带方向的价差，不能把该表收益解释成蝶式或铁秃鹰的盈利证明。Q0 选仓也只是重定价残差驱动的对照，正收益不能证明这些残差是可重复的优势。','',
              f"![PDE-E02 历史研究对照图]({OUT/'comparison.png'})",'',
              '## 相对 Q0 的差异与不确定性','',
              '采用 5 个连续有效交易日的循环区块重采样、2,000 次、固定种子。以下 95% 区间只是近似，不能充分涵盖结构变化、极端尾部或历史选择偏差。','',
              '| 模型 | 平均 CRPS 差（负为改善） | 近似 95% 区间 | 平均每日策略损益差 | 近似 95% 区间 |',
              '|---|---:|---|---:|---|']
    for name,b in result['bootstrap'].items():
        c,p = b['crps_difference_vs_Q0'],b['daily_policy_pnl_difference_vs_Q0']
        lines.append(f"| {name} | {c['mean_difference']:.4f} | {c['approximate_95pct_interval'][0]:.4f} 至 {c['approximate_95pct_interval'][1]:.4f} | ${p['mean_difference']:.2f} | ${p['approximate_95pct_interval'][0]:.2f} 至 ${p['approximate_95pct_interval'][1]:.2f} |")
    lines += ['','## 按月拆分','',
              '| 月份 | 模型 | 评估天数 | CRPS | 95% 覆盖 | 开仓天数 | 策略净损益 |',
              '|---|---|---:|---:|---:|---:|---:|']
    for row in result['monthly']:
        f,p = row['forecast'],row['policy']
        lines.append(f"| {row['month']} | {row['model']} | {f['days']} | {f['standardized_crps']:.4f} | {f['bands']['95']['coverage']:.1%} | {p['trades']} | ${p['net_pnl_usd']:.2f} |")
    lines += ['','## 数据拒绝与限制','']
    lines += [f"- {r['date']}：{r['reason']}" for r in result['refusals']]
    lines += ['','- 所有模型只在共同可用日比较，报价拒绝和预热日未算作成功预测。JSON 另存方向/尾部事件 Brier 分数、PIT 分箱、每笔风险与全部候选，缺失不填入未来报价。',
              '- 120 天窗口内 5% 尾部只对应少数历史事件，核平滑不创造新的极端行情证据。假设分布更灵活，并不等于估计更可靠。',
              '- 分钟 NBBO 与挂单量不能证明多腿同时成交，未计额外结算收费；未引入本金规模，因此不报告月收益率或年化收益。',
              '- 保留未来 60 个有效评估日的版本协议，从 2026-09-16 起事前留存预测。当前真正的未来评估样本数为 0；协议已记录，尚未创建定时任务。','',
              '## 复现与记录','', '```bash',
              '.cache/thetadata-venv/bin/python services/theta/pde_history.py --probe',
              '.cache/thetadata-venv/bin/python services/theta/pde_history.py',
              'npm run theta:calibrate -- run',
              '.cache/thetadata-venv/bin/python services/theta/audit_calibration.py', '```','',
              '同目录 `registered-plan.json` / `download-status.json` / `results.json` / `audit.json` 保存规则、逐日缓存状态、所有预测及候选现金流、独立审计。输入与代码哈希一致时直接复用结果。','']
    (OUT/'report.md').write_text('\n'.join(lines))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['run'])
    parser.parse_args()
    run()
