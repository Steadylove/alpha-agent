"""Independent E03 time-order, pricing, selection and cashflow audit."""
from collections import defaultdict
import json
import math
from pathlib import Path

import numpy as np
import polars as pl
from scipy.special import ndtr
from scipy.integrate import quad

from method_lock import ROOT, verify_method
from pde_history import sha, read_chain as old_10am_chain
from pde_search_data import OUT, register, read_chains, path_for
from pde_search_math import fit_probability, choose_probability, WeightedNormal
from forecast import plan as forecast_plan
from range_model import option_prediction


def option_value(f,v,k,right):
    d1=math.log(f/k)/v+v/2;d2=d1-v
    return f*float(ndtr(d1))-k*float(ndtr(d2)) if right=='call' else k*float(ndtr(-d2))-f*float(ndtr(-d1))


def audit():
    cfg,registered=register();verify_method()
    result=json.loads((OUT/'results.json').read_text())
    assert result['input_hashes']['plan']==registered['plan_sha256']
    assert result['input_hashes']['daily']==registered['daily_sha256']
    for name,digest in result['input_hashes']['code'].items():
        assert sha(ROOT/'services/theta'/name)==digest
    prepared=json.loads((OUT/'prepared.json').read_text())
    sources={(j['date'],j['expiration']):j for j in registered['jobs']}
    for key,job in sources.items():
        assert path_for(job).exists()
    assert len(result['input_hashes']['raw_jobs'])==len(sources)
    for day,expiry,digest in result['input_hashes']['raw_jobs']:
        assert sha(path_for(sources[(day,expiry)]))==digest
    transport_days=transport_contracts=0
    for job in sources.values():
        if job['offset']:
            continue
        chain=read_chains(job,cfg).get('10:00:00',{})
        if not any(q.get('quote_timestamp') for q in chain.values()):
            continue
        old,_=old_10am_chain(job['date']);transport_days+=1
        for key,q in chain.items():
            if key in old:
                assert all(q[k]==old[key][k] for k in ('bid','ask','bid_size','ask_size')), (job['date'],key)
                transport_contracts+=1
    for day,expiry,stamp,digest in result['input_hashes']['snapshots']:
        assert sha(path_for(sources[(day,expiry)]))==digest
    raw={(r['date'],r['expiration'],r['time']):r for r in prepared['prepared']}
    candidates=pl.read_parquet(OUT/'candidate-metrics.parquet')
    pools=defaultdict(list)
    for row in candidates.to_dicts():
        pools[(row['date'],row['expiration'],row['time'])].append(row)
    daily=json.loads(Path(registered['daily_source']).read_text())['rows']
    closes={r['date']:r['close'] for r in daily}
    histories=defaultdict(list);previous=defaultdict(list)
    count=selected_count=crps_checks=0
    for row in result['forecasts']:
        day,expiry,stamp=row['date'],row['expiration'],row['time'];group=(stamp,row['offset'])
        snap=raw[(day,expiry,stamp)];f=row['prediction']['forward'];w=row['prediction']['total_log_volatility']
        support=np.array(snap['market']['support']);mass=np.array(snap['market']['mass'])
        assert np.all(mass>=0) and abs(mass.sum()-1)<1e-9 and abs(mass@support-f)<1e-6
        if row['status']=='forecast':
            assert all(x<day for x in row['training']['training_expirations'])
            models,training=fit_probability(day,histories[group],row['features'],cfg)
            assert training==row['training']
            assert {name:m.description() for name,m in models.items()}==row['models']
            quality=choose_probability(day,previous[group],cfg)
            assert quality==row['quality']
            if quality:
                assert all(x<day for x in quality['validation_expirations'])
            pool=pools[(day,expiry,stamp)]
            for policy,selection in row['selected'].items():
                eligible=[]
                if quality and (quality['passes_quality_gate'] or policy=='ungated_research_ablation'):
                    model=quality['model'];e=cfg['execution']
                    eligible=[r for r in pool if r['ev_'+model]>=e['minimum_net_ev_usd']
                        and r['ev_'+model]/r['max_loss_usd']>=e['minimum_net_ev_to_max_loss']
                        and r['ev_Q_market']<=1e-7 and r['edge_'+model]>0
                        and (policy!='neutral_only_quality_gated' or r['family'] in cfg['neutral_families'])]
                if not eligible:
                    assert selection is None;continue
                best=max(eligible,key=lambda r:r['ev_'+model]/r['max_loss_usd'])
                assert selection['id']==best['candidate_id']
                d=row['models'][model]
                expected=0.
                for z,v,weight in zip(d['centers'],d['widths'],d['weights']):
                    component_vol=w*v;mu=math.log(f)-w*w/2+w*z
                    component_f=math.exp(mu+component_vol**2/2)
                    expected+=weight*sum(l['qty']*option_value(component_f,component_vol,l['strike'],l['right'])*100 for l in selection['legs'])
                cash=selection['entry_debit_points']*100+selection['opening_fees_usd']+selection['extra_slippage_usd']
                assert abs(expected-cash-selection['ev'][model])<2e-6
                selected_count+=1
            if count%100==0:
                z=(math.log(closes[expiry]/f)+w*w/2)/w
                for name,model in models.items():
                    low=float(np.min(model.centers-12*model.widths));high=float(np.max(model.centers+12*model.widths))
                    independent=quad(lambda x:model.cdf(x)**2,low,min(max(z,low),high),epsabs=1e-7)[0]
                    independent+=quad(lambda x:(1-model.cdf(x))**2,min(max(z,low),high),high,epsabs=1e-7)[0]
                    independent+=max(low-z,0,z-high)
                    assert abs(independent-row['scores'][name]['crps'])<1e-5
                    crps_checks+=1
            previous[group].append(row);count+=1
        z=(math.log(closes[expiry]/f)+w*w/2)/w
        histories[group].append({'date':day,'expiration':expiry,'z':z,'features':row['features']})
    trades_checked=0;observed_quote_ages=[]
    for policy,output in result['policies']['whole'].items():
        # Reconstruct chronological first-valid-time choice without calling portfolio replay.
        by_time=defaultdict(list)
        for row in result['forecasts']:
            if row.get('selected',{}).get(policy) is not None:
                by_time[(row['date'],row['time'])].append(row)
        expected=[];busy_through=None
        for (day,stamp),alternatives in sorted(by_time.items()):
            if busy_through is not None and day<=busy_through:
                continue
            selected=max(alternatives,key=lambda r:r['selected'][policy]['ev'][r['selected'][policy]['probability_model']]/r['selected'][policy]['max_loss_usd'])
            busy_through=selected['expiration']
            expected.append((day,stamp,busy_through,selected['selected'][policy]['id']))
        assert expected==[(r['date'],r['time'],r['expiration'],r['id']) for r in output['trades']]
        last_expiry=None;values=[]
        for trade in output['trades']:
            assert last_expiry is None or trade['date']>last_expiry
            last_expiry=trade['expiration']
            job=sources[(trade['date'],trade['expiration'])]
            chain=read_chains(job,cfg)[trade['time']]
            fcfg=forecast_plan();fcfg['option_snapshot_et']=trade['time']
            pred=option_prediction(trade['expiration'],chain,fcfg)
            cached=raw[(trade['date'],trade['expiration'],trade['time'])]['prediction']
            assert abs(pred['forward']-cached['forward'])<1e-9
            assert abs(pred['total_log_volatility']-cached['total_log_volatility'])<1e-12
            debit=0.
            for leg in trade['legs']:
                q=chain[(leg['strike'],leg['right'])];side='ask' if leg['qty']>0 else 'bid'
                assert q[side+'_size']>=abs(leg['qty'])
                if q.get('quote_timestamp') is not None:
                    age=(q['timestamp']-q['quote_timestamp']).total_seconds()
                    assert age>=0
                    observed_quote_ages.append(age)
                debit+=leg['qty']*q[side]
            assert abs(debit-trade['entry_debit_points'])<1e-8
            close=closes[trade['expiration']]
            value=sum(l['qty']*max(close-l['strike'] if l['right']=='call' else l['strike']-close,0)*100 for l in trade['legs'])
            count_contracts=sum(abs(l['qty']) for l in trade['legs'])
            pnl=value-debit*100-count_contracts*(cfg['execution']['fee_per_contract_usd']+100*cfg['execution']['extra_slippage_per_contract_points'])
            assert abs(pnl-trade['net_pnl_usd'])<1e-7
            assert trade['max_loss_usd']<=cfg['execution']['maximum_loss_usd']
            values.append(pnl);trades_checked+=1
        curve=np.r_[0,np.cumsum(values)]
        independent_dd=max((curve[i]-curve[j] for i in range(len(curve)) for j in range(i,len(curve))),default=0)
        assert abs(independent_dd-output['summary']['settled_max_drawdown_usd'])<1e-7
        assert abs(sum(values)-output['summary']['net_pnl_usd'])<1e-7
        assert abs(sum(m['net_pnl_usd'] for m in output['monthly'])-sum(values))<1e-7
    output={'all_passed':True,'raw_quote_jobs':len(sources),'forecast_training_audits':count,
            'independent_selected_EV_audits':selected_count,'independent_CRPS_quadratures':crps_checks,
            'policy_cashflows_checked':trades_checked,'candidate_pool_rows':candidates.height,
            'asof_versus_old_10am_days':transport_days,'asof_versus_old_10am_contracts':transport_contracts,
            'asof_versus_old_10am_bid_ask_size_differences':0,
            'asof_selected_leg_checks':len(observed_quote_ages),
            'asof_selected_leg_max_age_seconds':max(observed_quote_ages,default=None),
            'asof_selected_legs_older_than_60_seconds':sum(a>60 for a in observed_quote_ages),
            'audit_code_sha256':sha(ROOT/'services/theta/audit_search.py'),
            'note':'Policies and snapshot alternatives overlap; counts are not independent trades. Audits verify arithmetic and time order, not profitability.'}
    (OUT/'audit.json').write_text(json.dumps(output,indent=2)+'\n')
    print(json.dumps(output,indent=2))


if __name__=='__main__':
    audit()
