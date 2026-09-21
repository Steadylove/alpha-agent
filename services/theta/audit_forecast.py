"""Recompute forecasts and scores from archived inputs without future labels."""
from datetime import datetime, timezone
import hashlib
import json
import math
from statistics import NormalDist, mean, median, stdev

from forecast import OUT, PLAN, write_json


def near(a,b):
    assert abs(a-b)<1e-6,(a,b)


def main():
    r=json.loads((OUT/'evaluation.json').read_text())
    daily=json.loads((OUT/'spx-daily.json').read_text())
    cfg=r['plan']
    assert hashlib.sha256(PLAN.read_bytes()).hexdigest()==r['plan_sha256']
    assert hashlib.sha256((OUT/'spx-daily-raw.json').read_bytes()).hexdigest()==daily['raw_sha256']
    closes={x['date']:x['close'] for x in daily['rows']}
    scores={}
    models={(p['model'],p['target_date']):p for p in r['predictions']}
    inversion_checks=0
    normal=NormalDist()
    for p in sorted(r['predictions'],key=lambda p:(p['target_date'],p['model'])):
        day=p['target_date']
        if p['model']=='preopen_history':
            training=[x for x in daily['rows'] if x['date']<day][-cfg['daily_history_returns']-1:]
            assert len(training)==61 and training[-1]['date']==p['input_end_date']<day
            returns=[math.log(b['close']/a['close']) for a,b in zip(training,training[1:])]
            sigma=stdev(returns)
            center=training[-1]['close']*math.exp(mean(returns))
            near(center,p['median'])
            for coverage in cfg['coverage_levels']:
                z=normal.inv_cdf((1+coverage)/2)
                bounds=p['bands'][str(round(coverage*100))]
                near(bounds[0],center*math.exp(-z*sigma))
                near(bounds[1],center*math.exp(z*sigma))
        elif p['model']=='option_implied':
            forward=median(q['strike']+q['call_mid']-q['put_mid'] for q in p['quote_pairs'])
            near(forward,p['forward'])
            for q in p['quote_pairs']:
                near(q['call_mid'],(q['call_bid']+q['call_ask'])/2)
                near(q['put_mid'],(q['put_bid']+q['put_ask'])/2)
                w=q.get('total_volatility')
                if w is None:
                    continue
                d1=math.log(forward/q['strike'])/w+w/2
                d2=d1-w
                value=forward*(2*normal.cdf(d1)-1)-q['strike']*(2*normal.cdf(d2)-1)
                near(value,q['call_mid']+q['put_mid'])
                inversion_checks+=1
            w=median(q['total_volatility'] for q in p['quote_pairs'] if q.get('total_volatility') is not None)
            near(w,p['total_log_volatility'])
            for coverage in cfg['coverage_levels']:
                z=normal.inv_cdf((1+coverage)/2)
                bounds=p['bands'][str(round(coverage*100))]
                near(bounds[0],forward*math.exp(-w*w/2-z*w))
                near(bounds[1],forward*math.exp(-w*w/2+z*w))
            scores[day]=abs(math.log(closes[day]/forward)+w*w/2)/w
    for s in r['scores']:
        near(s['score'],scores[s['date']])
    for p in r['predictions']:
        if p['model']!='option_calibrated':
            continue
        day=p['target_date']
        dates=sorted(d for d in scores if d<day)[-cfg['calibration_maximum_sessions']:]
        assert dates==p['training_dates'] and len(dates)>=20 and max(dates)<day
        implied=models[('option_implied',day)]
        sorted_scores=sorted(scores[d] for d in dates)
        for coverage in cfg['coverage_levels']:
            label=str(round(coverage*100))
            q=sorted_scores[math.ceil((len(dates)+1)*coverage)-1]
            near(q,p['standardized_error_quantiles'][label])
            near(p['bands'][label][0],implied['median']*math.exp(-q*implied['total_log_volatility']))
            near(p['bands'][label][1],implied['median']*math.exp(q*implied['total_log_volatility']))
    for s in r['summaries']:
        subset=[p for p in r['predictions'] if p['model']==s['model']
                and (s['scope']=='available' or p['target_date'] in r['common_dates'])]
        label=str(round(s['nominal_coverage']*100))
        assert len(subset)==s['sessions']
        assert sum(p['bands'][label][0]<=closes[p['target_date']]<=p['bands'][label][1] for p in subset)==s['covered']
        interval_scores=[]
        for p in subset:
            lo,hi=p['bands'][label]
            y=closes[p['target_date']]
            interval_scores.append(hi-lo+2/(1-s['nominal_coverage'])*max(lo-y,0,y-hi))
        if subset:
            near(mean(interval_scores),s['mean_interval_score'])
    audit={'checked_at':datetime.now(timezone.utc).isoformat(),'historical_sessions':len(r['closes']),
           'own_forecasts_checked':sum(p['model']!='blogger' for p in r['predictions']),
           'atm_black_inversions':inversion_checks,'calibration_forecasts':sum(p['model']=='option_calibrated' for p in r['predictions']),
           'summary_metrics':len(r['summaries']),'quality_failures':r['failures'],
           'evaluation_sha256':hashlib.sha256((OUT/'evaluation.json').read_bytes()).hexdigest(),
           'cutoff_unit_tests':'Target-day and future daily closes/scores were mutated; forecasts unchanged.'}
    write_json(OUT/'audit.json',audit)
    print(json.dumps(audit,indent=2))


if __name__=='__main__':
    main()
