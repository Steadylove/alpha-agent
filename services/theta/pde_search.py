"""PDE-E03: time-causal multi-structure, multi-expiry research backtest."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import math
from pathlib import Path

import numpy as np
import polars as pl

from calibration import signed_residual
from density import terminal_payoff
from forecast import plan as forecast_plan, write_json
from method_lock import ROOT, verify_method
from pde_history import sha
from pde_search_data import register, OUT, path_for, read_chains
from pde_search_math import (DiscreteMarket, fit_market, state_features, fit_probability,
                            choose_probability, CASH_EARLY_CLOSE)
from pde_search_optimizer import price_candidates, select_candidates, enrich_selected
from range_model import option_prediction


def prepare(available=False):
    cfg,registered=register()
    daily=json.loads(Path(registered['daily_source']).read_text())['rows']
    snapshots=[];refusals=[];missing=[]
    math_sha=sha(ROOT/'services/theta/pde_search_math.py')
    for i,job in enumerate(registered['jobs']):
        if not path_for(job).exists():
            missing.append(job);continue
        raw_sha=sha(path_for(job))
        chains=read_chains(job,cfg)
        for stamp in cfg['entry_times_et']:
            cache=OUT/'derived'/f"{job['date']}-{job['expiration']}-{stamp.replace(':','')}.json"
            hashes={'raw':raw_sha,'math':math_sha,'plan':registered['plan_sha256'],
                    'daily':registered['daily_sha256'],'method':verify_method()['method_file_sha256']}
            if cache.exists() and (saved:=json.loads(cache.read_text()))['hashes']==hashes:
                row=saved
            else:
                row={**job,'time':stamp,'hashes':hashes,'status':'refused'}
                try:
                    if stamp>=CASH_EARLY_CLOSE.get(job['date'],'16:00:00'):
                        raise ValueError('Scheduled time is after the cash/expiring-option session close')
                    if stamp not in chains:
                        raise ValueError('Exact scheduled quote missing')
                    chain=chains[stamp]
                    fcfg=forecast_plan();fcfg['option_snapshot_et']=stamp
                    pred=option_prediction(job['expiration'],chain,fcfg)
                    pred['model']='E03_ATM_reference_for_actual_quote_time_and_expiry'
                    market,info=fit_market(chain,pred,cfg)
                    features,meta=state_features(job['date'],job['expiration'],stamp,chain,pred,daily)
                    row.update(status='prepared',prediction=pred,market={'support':market.support.tolist(),
                               'mass':market.mass.tolist(),'diagnostics':info},features=features,feature_details=meta)
                except ValueError as exc:
                    row['reason']=str(exc)
                write_json(cache,row)
            if row['status']=='prepared':snapshots.append(row)
            else:refusals.append(row)
        if (i+1)%50==0:
            print(json.dumps({'prepare_jobs':i+1,'prepared_snapshots':len(snapshots),'refusals':len(refusals)}),flush=True)
    if missing and not available:
        raise ValueError(f'Missing {len(missing)} input jobs; finish registered downloads first')
    result={'prepared':snapshots,'refusals':refusals,'missing_jobs':missing}
    write_json(OUT/('prepare-partial.json' if available else 'prepared.json'),result)
    print(json.dumps({'prepared':len(snapshots),'refused':len(refusals),'missing':len(missing)}),flush=True)
    return result


def score_models(models,market,pred,close):
    z=signed_residual(pred,close)
    result={}
    distributions={'Q_market':market,**{name:m.price_distribution(pred['forward'],pred['total_log_volatility']) for name,m in models.items()}}
    for name,distribution in distributions.items():
        scores={'crps':market.crps(z) if name=='Q_market' else models[name].crps(z),
                'pit':distribution.cdf(close),'bands':{}}
        for coverage in (.50,.68,.80,.90,.95):
            low,high=distribution.quantile((1-coverage)/2),distribution.quantile((1+coverage)/2)
            scores['bands'][str(round(100*coverage))]={'low':low,'high':high,'covered':low<=close<=high,
                 'interval_score':high-low+2/(1-coverage)*max(low-close,close-high,0)}
        threshold=pred['median']
        prob=1-distribution.cdf(threshold)
        scores['brier_above_atm_median']=(prob-float(close>threshold))**2
        result[name]=scores
    return result


def forecasts(prepared,cfg,registered):
    daily=json.loads(Path(registered['daily_source']).read_text())['rows']
    closes={r['date']:r['close'] for r in daily}
    histories=defaultdict(list);previous=defaultdict(list)
    rows=[];candidate_rows=[];warmup=[]
    jobs={(j['date'],j['expiration']):j for j in registered['jobs']}
    last_job=None;chains=None
    for i,snap in enumerate(sorted(prepared,key=lambda r:(r['date'],r['time'],r['expiration']))):
        day,expiry,stamp=snap['date'],snap['expiration'],snap['time'];group=(stamp,snap['offset'])
        pred=snap['prediction']
        market=DiscreteMarket(snap['market']['support'],snap['market']['mass'],pred['forward'],pred['total_log_volatility'])
        fitted=fit_probability(day,histories[group],snap['features'],cfg)
        row={k:snap[k] for k in ('date','expiration','time','offset','features','hashes')}
        row.update(status='warmup',selected={},prediction=pred,market_diagnostics=snap['market']['diagnostics'])
        if fitted:
            models,training=fitted
            quality=choose_probability(day,previous[group],cfg)
            job=jobs[(day,expiry)]
            if last_job!=(day,expiry):
                chains=read_chains(job,cfg);last_job=(day,expiry)
            priced,diagnostics=price_candidates(pred,market,models,chains[stamp],cfg)
            row.update(status='forecast',training=training,quality=quality,candidate_diagnostics=diagnostics,
                       models={name:model.description() for name,model in models.items()})
            for policy in cfg['policies']:
                if quality is None:
                    row['selected'][policy]=None;continue
                selection_quality=quality if policy!='ungated_research_ablation' else {**quality,'passes_quality_gate':True}
                model=quality['model']
                selected=select_candidates(priced,model,selection_quality,cfg,neutral=policy=='neutral_only_quality_gated')
                row['selected'][policy]=enrich_selected(selected,model,pred,models[model],cfg)
            for candidate in priced:
                candidate_rows.append({'date':day,'expiration':expiry,'time':stamp,'offset':snap['offset'],
                    'family':candidate['family'],'candidate_id':candidate['id'],'legs':json.dumps(candidate['legs']),
                    'entry_debit_points':candidate['entry_debit_points'],'max_loss_usd':candidate['max_loss_usd'],
                    'max_profit_usd':candidate['max_profit_usd'],
                    **{f'ev_{name}':value for name,value in candidate['ev'].items()},
                    **{f'edge_{name}':value for name,value in candidate['p_minus_q_expected_payoff_usd'].items()},
                    'q_mid_repricing_residual_usd':candidate['q_mid_repricing_residual_usd'],
                    'spread_cost_usd':candidate['natural_minus_mid_usd']})
            # Only now access this expiry's outcome. Filters intrinsically require maturity.
            row['scores']=score_models(models,market,pred,closes[expiry])
            previous[group].append(row)
        else:
            warmup.append({k:row[k] for k in ('date','expiration','time','offset')})
        histories[group].append({'date':day,'expiration':expiry,'z':signed_residual(pred,closes[expiry]),'features':snap['features']})
        rows.append(row)
        if (i+1)%100==0:
            print(json.dumps({'forecast_snapshots':i+1,'total':len(prepared),'priced_candidates':len(candidate_rows)}),flush=True)
    if candidate_rows:
        pl.DataFrame(candidate_rows).write_parquet(OUT/'candidate-metrics.parquet')
    return rows,warmup,len(candidate_rows)


def replay_policy(rows,policy,cfg,closes,start=None,end=None):
    start=start or cfg['input_start'];end=end or cfg['last_decision_date']
    grouped=defaultdict(list)
    for row in rows:
        if start<=row['date']<=end:
            grouped[(row['date'],row['time'])].append(row)
    # Include scheduled sessions whose entire chain failed quality checks.
    by_day=sorted(day for day in closes if start<=day<=end)
    trades=[];decisions=[];held_expiry=None
    for day in by_day:
        entered=False
        for stamp in cfg['entry_times_et']:
            available=grouped.get((day,stamp),[])
            if held_expiry is not None and day<=held_expiry:
                decisions.append({'date':day,'time':stamp,'action':'NO_TRADE','reason':'existing_position_until_expiry','held_expiry':held_expiry});continue
            if entered:
                continue
            choices=[(r,r.get('selected',{}).get(policy)) for r in available]
            choices=[(r,c) for r,c in choices if c is not None]
            if not choices:
                reason=('no_usable_snapshot' if not available
                        else 'insufficient_training_or_validation' if not any(r.get('quality') for r in available)
                        else 'quality_gate_failed' if policy!='ungated_research_ablation' and not any(r.get('quality',{}).get('passes_quality_gate',False) for r in available if r.get('quality'))
                        else 'no_positive_cost_adjusted_candidate')
                decisions.append({'date':day,'time':stamp,'action':'NO_TRADE','reason':reason});continue
            row,selected=max(choices,key=lambda rc:rc[1]['ev'][rc[1]['probability_model']]/rc[1]['max_loss_usd'])
            # Commit structure, date and expiry before attaching its terminal cashflow.
            trade={'date':day,'time':stamp,'expiration':row['expiration'],'offset':row['offset'],
                   'policy':policy,'quality':row['quality'],**selected}
            held_expiry=row['expiration'];entered=True
            e=cfg['execution'];payoff=terminal_payoff(trade['legs'],closes[held_expiry])
            no_extra=payoff-trade['entry_debit_points']*100-trade['opening_fees_usd']
            trade.update(observed_settlement_proxy=closes[held_expiry],no_extra_slip_pnl_usd=no_extra,
                         net_pnl_usd=no_extra-trade['extra_slippage_usd'],
                         stressed_pnl_usd=no_extra-trade['contract_count']*e['stress_extra_slippage_per_contract_points']*100)
            assert -trade['max_loss_usd']-1e-6<=trade['net_pnl_usd']<=trade['max_profit_usd']+1e-6
            trades.append(trade)
            decisions.append({'date':day,'time':stamp,'expiration':held_expiry,'action':'SIMULATED_ENTRY','family':trade['family']})
    return {'trades':trades,'decisions':decisions,'decision_days':len(by_day)}


def summary(trades):
    ordered=sorted(trades,key=lambda r:(r['expiration'],r['date'],r['time']))
    values=[r['net_pnl_usd'] for r in ordered];wins=[v for v in values if v>0];losses=[v for v in values if v<0]
    curve=np.r_[0.,np.cumsum(values)];dd=float(np.max(np.maximum.accumulate(curve)-curve))
    stress=np.r_[0.,np.cumsum([r['stressed_pnl_usd'] for r in ordered])]
    streak=longest=0
    for value in values:
        streak=streak+1 if value<0 else 0
        longest=max(longest,streak)
    return {'trades':len(trades),'wins':len(wins),'losses':len(losses),'win_rate':len(wins)/len(values) if values else None,
            'net_pnl_usd':sum(values),'no_extra_slip_pnl_usd':sum(r['no_extra_slip_pnl_usd'] for r in trades),
            'stress_pnl_usd':sum(r['stressed_pnl_usd'] for r in trades),
            'settled_max_drawdown_usd':dd,'stressed_settled_max_drawdown_usd':float(np.max(np.maximum.accumulate(stress)-stress)),
            'mean_win_usd':float(np.mean(wins)) if wins else None,'mean_loss_usd':float(np.mean(losses)) if losses else None,
            'longest_losing_streak_trades':longest,
            'worst_trade_usd':min(values) if values else None,'largest_contractual_loss_usd':max((r['max_loss_usd'] for r in trades),default=0),
            'families':dict(Counter(r['family'] for r in trades)),'entry_times':dict(Counter(r['time'] for r in trades)),
            'expiry_offsets':dict(Counter(str(r['offset']) for r in trades)),'models':dict(Counter(r['probability_model'] for r in trades))}


def aggregate(rows,cfg,closes):
    outputs={}
    whole={policy:replay_policy(rows,policy,cfg,closes) for policy in cfg['policies']}
    for scope,start,end in [('whole',None,None),('development',None,cfg['evaluation']['development_end']),
                            ('evaluation',cfg['evaluation']['evaluation_start'],None)]:
        outputs[scope]={}
        for policy in cfg['policies']:
            # Preserve a continuous portfolio across the split, including occupied days.
            inside=lambda day:(start is None or day>=start) and (end is None or day<=end)
            result={'trades':[r for r in whole[policy]['trades'] if inside(r['date'])],
                    'decisions':[r for r in whole[policy]['decisions'] if inside(r['date'])]}
            result['decision_days']=len({r['date'] for r in result['decisions']})
            result['summary']=summary(result['trades'])
            result['summary']['no_entry_days']=result['decision_days']-len(result['trades'])
            months=sorted({r['date'][:7] for r in result['decisions']})
            result['monthly']=[{'month':month,**summary([r for r in result['trades'] if r['date'].startswith(month)])} for month in months]
            outputs[scope][policy]=result
    return outputs


def run(smoke=False):
    cfg,registered=register();verify_method()
    prepared=prepare(available=smoke)
    snaps=prepared['prepared']
    if smoke:
        # Enough genuine earlier history to exercise training, validation and pricing.
        first_days=set(sorted({r['date'] for r in snaps})[:100])
        snaps=[r for r in snaps if r['date'] in first_days]
    code=['pde_search.py','pde_search_data.py','pde_search_math.py','pde_search_optimizer.py','density.py','range_model.py',
          'calibration.py','forecast.py','replay.py','pde_history.py','provider.py','method_lock.py']
    hashes={'plan':registered['plan_sha256'],'daily':registered['daily_sha256'],
            'code':{name:sha(ROOT/'services/theta'/name) for name in code},
            'raw_jobs':[(j['date'],j['expiration'],sha(path_for(j))) for j in registered['jobs'] if path_for(j).exists()],
            'snapshots':[(r['date'],r['expiration'],r['time'],r['hashes']['raw']) for r in snaps]}
    target=OUT/('smoke-results.json' if smoke else 'results.json')
    if target.exists() and (cached:=json.loads(target.read_text()))['input_hashes']==hashes:
        print(json.dumps({'cache':'hit','totals':cached['totals']}));return cached
    rows,warmup,candidate_count=forecasts(snaps,cfg,registered)
    closes={r['date']:r['close'] for r in json.loads(Path(registered['daily_source']).read_text())['rows']}
    policies=aggregate(rows,cfg,closes)
    scores={}
    scored=[r for r in rows if r['status']=='forecast']
    for scope in ('whole','evaluation'):
        subset=[r for r in scored if scope=='whole' or r['date']>=cfg['evaluation']['evaluation_start']]
        scores[scope]={name:{'forecasts':len(subset),'mean_crps':float(np.mean([r['scores'][name]['crps'] for r in subset])) if subset else None,
                       'coverage':{level:float(np.mean([r['scores'][name]['bands'][level]['covered'] for r in subset])) if subset else None for level in ('50','68','80','90','95')}}
                       for name in ['Q_market',*cfg['probability_models']]}
    result={'created_at':datetime.now(timezone.utc).isoformat(),'plan':cfg,'input_hashes':hashes,
            'totals':{'requested_quote_jobs':len(registered['jobs']),'prepared_snapshots':len(prepared['prepared']),
                      'refused_snapshots':len(prepared['refusals']),'warmup_snapshots':len(warmup),
                      'scored_forecasts':len(scored),'priced_candidates':candidate_count,'prospective_sessions':0},
            'forecasts':rows,'refusals':prepared['refusals'],'policies':policies,'distribution_scores':scores,
            'interpretation':cfg['evaluation']['sample_status']}
    write_json(target,result)
    print(json.dumps({'totals':result['totals'],'summaries':{scope:{p:r['summary'] for p,r in group.items()} for scope,group in policies.items()}},indent=2),flush=True)
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['prepare','run'])
    parser.add_argument('--available',action='store_true')
    parser.add_argument('--smoke',action='store_true')
    args=parser.parse_args()
    prepare(args.available) if args.action=='prepare' else run(args.smoke)
