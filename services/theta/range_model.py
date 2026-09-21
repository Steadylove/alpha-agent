"""Frozen v1 range mathematics, independent of data fetching and trade selection.

Prediction functions accept only prices available at their stated cutoff. Change
this module only as a new method version; range-method-v1.json records its hash.
"""
from __future__ import annotations

import math
import statistics

from scipy.optimize import brentq
from scipy.special import ndtr, ndtri


def preopen_prediction(target_date, daily_rows, cfg):
    earlier=[r for r in daily_rows if r['date']<target_date]
    n=cfg['daily_history_returns']
    if len(earlier)<n+1:
        raise ValueError('Insufficient earlier daily returns')
    training=earlier[-n-1:]
    returns=[math.log(b['close']/a['close']) for a,b in zip(training,training[1:])]
    mean=statistics.mean(returns)
    sigma=statistics.stdev(returns)
    if not math.isfinite(sigma) or sigma<=1e-12:
        raise ValueError('Degenerate historical volatility; no forecast issued')
    center=training[-1]['close']*math.exp(mean)
    return {'model':'preopen_history','target_date':target_date,'input_end_date':training[-1]['date'],
        'training_start_date':training[0]['date'],'training_returns':n,
        'median':center,'daily_log_return_mean':mean,'daily_log_return_std':sigma,
        'bands':{str(round(c*100)):[center*math.exp(-float(ndtri((1+c)/2))*sigma),
                                  center*math.exp(float(ndtri((1+c)/2))*sigma)] for c in cfg['coverage_levels']}}


def black_straddle(forward, strike, total_vol):
    if total_vol<=0:
        return abs(forward-strike)
    d1=math.log(forward/strike)/total_vol+total_vol/2
    d2=d1-total_vol
    return forward*(2*float(ndtr(d1))-1)-strike*(2*float(ndtr(d2))-1)


def option_prediction(target_date, chain, cfg):
    """No close, blogger range or next-minute price is accepted by this function."""
    pairs={}
    for (strike,right),q in chain.items():
        if (all(math.isfinite(q[k]) for k in ('bid','ask')) and 0<q['bid']<=q['ask']
                and q['ask']-q['bid']<=cfg['maximum_leg_spread_points']+1e-9
                and q['bid_size']>=1 and q['ask_size']>=1):
            pairs.setdefault(strike,{})[right]=q
    available=[]
    for strike,pair in pairs.items():
        if 'call' in pair and 'put' in pair:
            call=(pair['call']['bid']+pair['call']['ask'])/2
            put=(pair['put']['bid']+pair['put']['ask'])/2
            available.append({'strike':strike,'call_mid':call,'put_mid':put,
                'forward':strike+call-put,'call_quote':pair['call'],'put_quote':pair['put']})
    selected=sorted(available,key=lambda x:(abs(x['call_mid']-x['put_mid']),x['strike']))[:cfg['atm_pair_count']]
    if len(selected)<cfg['minimum_atm_pairs']:
        raise ValueError('Insufficient liquid near-ATM put/call pairs')
    forwards=[p['forward'] for p in selected]
    if max(forwards)-min(forwards)>cfg['maximum_parity_forward_range_points']:
        raise ValueError('Put/call parity dispersion exceeds the predeclared quality threshold')
    forward=statistics.median(forwards)
    volatilities=[]
    for pair in selected:
        premium=pair['call_mid']+pair['put_mid']
        if not abs(forward-pair['strike'])<premium<forward+pair['strike']:
            continue
        vol=brentq(lambda v:black_straddle(forward,pair['strike'],v)-premium,1e-9,5,xtol=1e-13)
        pair['total_volatility']=vol
        volatilities.append(vol)
    if len(volatilities)<cfg['minimum_atm_pairs']:
        raise ValueError('Insufficient solvable ATM total volatilities')
    vol=statistics.median(volatilities)
    median=forward*math.exp(-vol*vol/2)
    # Keep only fields useful to reproduce the input quotes; stringify timestamp.
    used=[{'strike':p['strike'],'call_mid':p['call_mid'],'put_mid':p['put_mid'],
           'forward':p['forward'],'total_volatility':p.get('total_volatility'),
           **{f'{right}_{field}':p[f'{right}_quote'][field] for right in ('call','put')
              for field in ('bid','ask','bid_size','ask_size')}} for p in selected]
    return {'model':'option_implied','target_date':target_date,'quote_time_et':cfg['option_snapshot_et'],
        'forward':forward,'median':median,'total_log_volatility':vol,
        'forward_dispersion_points':max(forwards)-min(forwards),'quote_pairs':used,
        'bands':{str(round(c*100)):[median*math.exp(-float(ndtri((1+c)/2))*vol),
                                  median*math.exp(float(ndtri((1+c)/2))*vol)] for c in cfg['coverage_levels']}}


def calibration_score(prediction, close):
    vol=prediction['total_log_volatility']
    return abs(math.log(close/prediction['forward'])+vol*vol/2)/vol


def calibrated_prediction(current, earlier_scores, cfg):
    past=sorted((s for s in earlier_scores if s['date']<current['target_date']),key=lambda s:s['date'])[-cfg['calibration_maximum_sessions']:]
    if len(past)<cfg['calibration_minimum_sessions']:
        return None
    sorted_scores=sorted(s['score'] for s in past)
    multipliers={}
    bands={}
    for coverage in cfg['coverage_levels']:
        k=math.ceil((len(past)+1)*coverage)
        if k>len(past):
            return None
        q=sorted_scores[k-1]
        label=str(round(coverage*100))
        multipliers[label]=q
        bands[label]=[current['median']*math.exp(-q*current['total_log_volatility']),
                      current['median']*math.exp(q*current['total_log_volatility'])]
    return {'model':'option_calibrated','target_date':current['target_date'],
        'quote_time_et':current['quote_time_et'],'median':current['median'],
        'training_dates':[s['date'] for s in past],'calibration_count':len(past),
        'standardized_error_quantiles':multipliers,'bands':bands}


def interval_metrics(predictions, closes, coverage):
    label=str(round(coverage*100))
    values=[]
    for p in predictions:
        low,high=p['bands'][label]
        actual=closes[p['target_date']]
        miss=max(low-actual,0,actual-high)
        values.append({'covered':low<=actual<=high,'width':high-low,
            'width_pct':(high-low)/((high+low)/2)*100,'score':high-low+2/(1-coverage)*miss})
    return {'sessions':len(values),'covered':sum(v['covered'] for v in values),
        'coverage':sum(v['covered'] for v in values)/len(values) if values else None,
        'mean_width_points':statistics.mean(v['width'] for v in values) if values else None,
        'mean_width_pct':statistics.mean(v['width_pct'] for v in values) if values else None,
        'mean_interval_score':statistics.mean(v['score'] for v in values) if values else None}
