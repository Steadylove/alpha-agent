"""Independent audit of PDE-E02 dates, mixture pricing, scores and selections."""
from datetime import datetime,timezone
import json
import math
from pathlib import Path
from statistics import NormalDist,mean,stdev

import numpy as np
from scipy.integrate import quad

from forecast import option_prediction,plan as forecast_plan,write_json
from method_lock import ROOT,verify_method
from pde_history import OUT,PLAN,read_chain,sha
from replay import settlement_pnl

N = NormalDist()


def black(forward,vol,strike,right):
    d1 = math.log(forward/strike)/vol+vol/2
    d2 = d1-vol
    return (forward*N.cdf(d1)-strike*N.cdf(d2) if right=='call'
            else strike*N.cdf(-d2)-forward*N.cdf(-d1))


def audit():
    path = OUT/'results.json'
    result = json.loads(path.read_text())
    cfg = result['experiment']
    registration = json.loads((OUT/'registered-plan.json').read_text())
    assert result['input_hashes']['plan_sha256']==registration['plan_sha256']==sha(PLAN)
    assert registration['daily_sha256']==sha(OUT/'daily-input.json')
    assert result['input_hashes']['method']==verify_method()['method_file_sha256']
    for filename,digest in result['input_hashes']['code'].items():
        assert sha(ROOT/'services/theta'/filename)==digest
    assert sha(ROOT/cfg['economic_probe']['candidate_plan'])==registration['candidate_plan_sha256']
    candidate_cfg = json.loads((ROOT/cfg['economic_probe']['candidate_plan']).read_text())
    closes = {r['date']:r['close'] for r in json.loads((OUT/'daily-input.json').read_text())['rows']}
    history = result['residual_history']
    residual_by_date = {r['date']:r for r in history}
    max_error = {'mixture_EV_usd':0.,'expiry_pnl_usd':0.,'crps_quadrature':0.}
    predictions = {r['date']:r for r in result['forecasts']}
    for day,digest in result['input_hashes']['quotes'].items():
        chain,source = read_chain(day)
        assert source['sha256']==digest
        try:
            p = option_prediction(day,chain,forecast_plan())
        except ValueError:
            assert day not in residual_by_date
            continue
        r = residual_by_date[day]
        assert p['forward']==r['forward'] and p['total_log_volatility']==r['total_vol']
        expected_z = (math.log(closes[day]/p['forward'])+p['total_log_volatility']**2/2)/p['total_log_volatility']
        assert abs(expected_z-r['z'])<1e-12
    archived = json.loads((ROOT/'data/thetadata/self-forecast-v1/evaluation.json').read_text())
    matched_old = 0
    for p in archived['predictions']:
        if p['model']=='option_implied' and p['target_date'] in residual_by_date:
            r = residual_by_date[p['target_date']]
            assert p['forward']==r['forward'] and p['total_log_volatility']==r['total_vol']
            matched_old += 1
    quadrature_dates = set()
    for month in sorted({d[:7] for d in predictions}):
        dates = sorted(d for d in predictions if d.startswith(month))
        quadrature_dates.update([dates[0],dates[-1]])
    components = {}
    for day,row in predictions.items():
        past = [r for r in history if r['date']<day][-cfg['maximum_training_sessions']:]
        assert len(past)>=cfg['minimum_training_sessions']
        assert row['training']['training_dates']==[r['date'] for r in past]
        values = [r['z'] for r in past]
        mu,sigma = mean(values),stdev(values)
        bandwidth = 1.06*sigma*len(values)**(-.2)
        assert abs(mu-row['training']['sample_mean'])<1e-12
        assert abs(sigma-row['training']['sample_std'])<1e-12
        assert abs(bandwidth-row['training']['kernel_bandwidth'])<1e-12
        for name,model in row['models'].items():
            actual = model['distribution']
            centers,widths = (([0.],[1.]) if name=='Q0' else ([mu],[sigma]) if name=='P_normal'
                              else (values,[bandwidth]*len(values)))
            assert np.allclose(actual['centers'],centers,rtol=0,atol=1e-12)
            assert np.allclose(actual['widths'],widths,rtol=0,atol=1e-12)
            implied = row['implied']
            base_mu = math.log(implied['forward'])-implied['total_log_volatility']**2/2
            w = implied['total_log_volatility']
            components[(day,name)] = [(math.exp(base_mu+w*m+.5*(w*s)**2),w*s) for m,s in zip(centers,widths)]
            def cdf(z):
                return sum(N.cdf((z-m)/s) for m,s in zip(centers,widths))/len(centers)
            observed_z = row['observed_z']
            scores = model['scores']
            assert abs(scores['pit']-cdf(observed_z))<1e-10
            for label,band in scores['bands'].items():
                p = (1-int(label)/100)/2
                zl = (math.log(band['low'])-base_mu)/w
                zh = (math.log(band['high'])-base_mu)/w
                assert abs(cdf(zl)-p)<1e-9 and abs(cdf(zh)-(1-p))<1e-9
                close = closes[day]
                assert band['covered']==(band['low']<=close<=band['high'])
                expected_score = band['high']-band['low']+2/(1-int(label)/100)*max(band['low']-close,close-band['high'],0.)
                assert abs(band['interval_score_points']-expected_score)<1e-7
            if day in quadrature_dates:
                low = min(min(centers)-12*max(widths),observed_z-1)
                high = max(max(centers)+12*max(widths),observed_z+1)
                numeric = quad(lambda z:cdf(z)**2,low,observed_z,epsabs=1e-8,limit=200)[0]
                numeric += quad(lambda z:(1-cdf(z))**2,observed_z,high,epsabs=1e-8,limit=200)[0]
                error = abs(numeric-scores['standardized_crps'])
                max_error['crps_quadrature'] = max(max_error['crps_quadrature'],error)
                assert error<1e-6
    keyed = {}
    for row in result['candidate_records']:
        if row['status']!='priced':
            continue
        count = sum(abs(l['qty']) for l in row['legs'])
        natural = sum(l['qty']*l['ask' if l['qty']>0 else 'bid'] for l in row['entry_quotes'])
        assert abs(natural-row['entry_debit_points'])<1e-10
        for l in row['entry_quotes']:
            assert 0<=l['bid']<=l['ask']
            assert l['ask_size' if l['qty']>0 else 'bid_size']>=abs(l['qty'])
        expected_payoff = 0.
        models = components[(row['date'],row['probability_model'])]
        for forward,vol in models:
            expected_payoff += sum(l['qty']*black(forward,vol,l['strike'],l['right'])*100 for l in row['legs'])/len(models)
        expected_ev = expected_payoff-natural*100-count*candidate_cfg['fee_per_contract_usd']
        error = abs(expected_ev-row['metrics']['model_ev_net_usd'])
        max_error['mixture_EV_usd'] = max(max_error['mixture_EV_usd'],error)
        assert error<2e-6
        pnl = settlement_pnl(row['legs'],natural,closes[row['date']],candidate_cfg['fee_per_contract_usd'])
        pnl -= count*100*cfg['economic_probe']['additional_slippage_per_contract_points']
        error = abs(pnl-row['observed_stressed_pnl_usd'])
        max_error['expiry_pnl_usd'] = max(max_error['expiry_pnl_usd'],error)
        assert error<1e-8
        keyed[(row['date'],row['probability_model'],row['candidate'])] = row
    for decision in result['policy_records']:
        eligible = []
        for candidate in candidate_cfg['candidates']:
            row = keyed.get((decision['date'],decision['probability_model'],candidate))
            if row is None:
                continue
            extra = row['contract_count']*100*cfg['economic_probe']['additional_slippage_per_contract_points']
            m = row['metrics']
            ev,risk = m['model_ev_net_usd']-extra,m['max_loss_net_usd']+extra
            if ev>0 and 0<risk<=cfg['economic_probe']['maximum_loss_usd'] and m['net_pnl_max_usd']-extra>0:
                eligible.append((ev/risk,candidate))
        selected = max(eligible,key=lambda v:v[0])[1] if eligible else 'no_trade'
        assert selected==decision['candidate']
        actual = 0. if selected=='no_trade' else keyed[(decision['date'],decision['probability_model'],selected)]['observed_stressed_pnl_usd']
        assert actual==decision['observed_stressed_pnl_usd']
    for name,summary in result['policy_summaries'].items():
        rows = [r for r in result['policy_records'] if r['probability_model']==name]
        assert len(rows)==len(predictions)
        assert sum(r['candidate']!='no_trade' for r in rows)==summary['trades']
        assert abs(sum(r['observed_stressed_pnl_usd'] for r in rows)-summary['net_pnl_usd'])<1e-8
    payload = {'created_at':datetime.now(timezone.utc).isoformat(),'all_passed':True,
               'results_sha256':sha(path),'audit_code_sha256':sha(Path(__file__)),
               'raw_sessions_verified':len(result['input_hashes']['quotes']),
               'old_frozen_forecasts_matched':matched_old,'chronological_fits_checked':len(predictions),
               'independent_crps_quadratures':len(quadrature_dates)*len(cfg['models']),
               'independent_candidate_cashflow_and_EV_checks':len(keyed),
               'selections_verified':len(result['policy_records']),'maximum_absolute_errors':max_error,
               'limits':'Numerical and chronology audit, not independent future performance evidence or a fill guarantee.'}
    write_json(OUT/'audit.json',payload)
    print(json.dumps(payload,ensure_ascii=False,indent=2))


if __name__=='__main__':
    audit()
