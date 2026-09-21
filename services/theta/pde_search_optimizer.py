"""Finite structure search. No realized outcome is accepted by the selector."""
from collections import Counter
import math

import numpy as np

from density import terminal_payoff, pnl_metrics
from replay import open_cost, quote_valid, legs_for_band


def generate_structures(pred,market,cfg):
    c=cfg['structures'];step=c['strike_step'];center=pred['median'];scale=pred['forward']*pred['total_log_volatility']
    rounded=lambda value:math.floor(value/step+.5)*step
    leg=lambda k,r,q:{'strike':k,'right':r,'qty':q}
    rows=[];seen=set()
    def add(family,legs):
        key=tuple(sorted((l['strike'],l['right'],l['qty']) for l in legs))
        if key not in seen and all(l['strike']>0 for l in legs):
            seen.add(key);rows.append({'family':family,'legs':legs,'id':str(len(rows))})
    for location in c['vertical_locations_sigma']:
        k=rounded(center+location*scale)
        for width in c['vertical_width_points']:
            for right in ('call','put'):
                other=k+width if right=='call' else k-width
                for direction,name in ((1,'debit'),(-1,'credit')):
                    add(f'{right}_{name}',[leg(k,right,direction),leg(other,right,-direction)])
    for probability in c['condor_central_probabilities']:
        low,high=market.quantile((1-probability)/2),market.quantile((1+probability)/2)
        for width in c['vertical_width_points']:
            add('iron_condor',legs_for_band(low,high,width,step))
    for location in c['butterfly_centers_sigma']:
        k=rounded(center+location*scale)
        for width in c['butterfly_wings_points']:
            for right in ('call','put'):
                add(f'{right}_butterfly',[leg(k-width,right,1),leg(k,right,-2),leg(k+width,right,1)])
            add('iron_butterfly',[leg(k-width,'put',1),leg(k,'put',-1),leg(k,'call',-1),leg(k+width,'call',1)])
        for left,right in c['broken_wing_pairs']:
            add('call_broken_wing',[leg(k-left,'call',1),leg(k,'call',-2),leg(k+right,'call',1)])
    return rows


def price_candidates(pred,market,models,chain,cfg):
    candidates=generate_structures(pred,market,cfg);execution=cfg['execution']
    needed=sorted({(l['strike'],l['right']) for row in candidates for l in row['legs']})
    strikes,rights=zip(*needed)
    fair={'Q_market':dict(zip(needed,market.expected_options(strikes,rights)))}
    distributions={name:m.price_distribution(pred['forward'],pred['total_log_volatility']) for name,m in models.items()}
    fair.update({name:dict(zip(needed,d.expected_options(strikes,rights))) for name,d in distributions.items()})
    rows=[];rejections=Counter()
    for candidate in candidates:
        legs=candidate['legs']
        if any(not quote_valid(chain.get((l['strike'],l['right'])),'ask' if l['qty']>0 else 'bid',l['qty'])
               or chain[(l['strike'],l['right'])]['ask']-chain[(l['strike'],l['right'])]['bid']>execution['maximum_leg_spread_points']+1e-9
               for l in legs):
            rejections['quote_or_size_or_spread']+=1;continue
        natural,mid=open_cost(legs,chain,'natural'),open_cost(legs,chain,'mid')
        count=sum(abs(l['qty']) for l in legs)
        fees=count*execution['fee_per_contract_usd'];slip=count*execution['extra_slippage_per_contract_points']*100
        payoff=[terminal_payoff(legs,s) for s in [0.,*[l['strike'] for l in legs]]]
        minimum,maximum=min(payoff),max(payoff)
        if not minimum-1e-6<=mid*100<=maximum+1e-6 or natural*100<minimum-1e-6:
            rejections['cross_leg_price_bounds']+=1;continue
        total=natural*100+fees+slip;risk=max(0.,total-minimum);profit=maximum-total
        if risk<=0 or risk>execution['maximum_loss_usd'] or profit<=0:
            rejections['risk_or_no_positive_payoff']+=1;continue
        expected={name:100*sum(l['qty']*prices[(l['strike'],l['right'])] for l in legs)
                  for name,prices in fair.items()}
        ev={name:value-total for name,value in expected.items()}
        spread=(natural-mid)*100;q_residual=expected['Q_market']-mid*100
        edge={name:value-expected['Q_market'] for name,value in expected.items() if name!='Q_market'}
        assert all(abs(edge[name]+q_residual-spread-fees-slip-ev[name])<1e-6 for name in edge)
        rows.append({**candidate,'entry_debit_points':natural,'mid_debit_points':mid,'contract_count':count,
                     'opening_fees_usd':fees,'extra_slippage_usd':slip,'max_loss_usd':risk,'max_profit_usd':profit,
                     'ev':ev,'p_minus_q_expected_payoff_usd':edge,'q_mid_repricing_residual_usd':q_residual,
                     'natural_minus_mid_usd':spread,
                     'displayed_group_limit':min(int(chain[(l['strike'],l['right'])]['ask_size' if l['qty']>0 else 'bid_size'])//abs(l['qty']) for l in legs)})
    return rows,{'generated':len(candidates),'priced_within_risk':len(rows),'rejections':dict(rejections)}


def select_candidates(rows,model,quality,cfg,neutral=False):
    if quality is None or not quality['passes_quality_gate']:
        return None
    e=cfg['execution']
    eligible=[r for r in rows if r['ev'][model]>=e['minimum_net_ev_usd']
              and r['ev'][model]/r['max_loss_usd']>=e['minimum_net_ev_to_max_loss']
              # A Q repricing inconsistency must never be relabeled as predictive alpha.
              and r['ev']['Q_market']<=1e-7 and r['p_minus_q_expected_payoff_usd'][model]>0
              and (not neutral or r['family'] in cfg['neutral_families'])]
    if not eligible:
        return None
    # Stable original candidate order breaks ties; outcomes are absent.
    return max(eligible,key=lambda r:r['ev'][model]/r['max_loss_usd'])


def enrich_selected(row,model,pred,distribution,cfg):
    if row is None:
        return None
    e=cfg['execution']
    metrics=pnl_metrics(row['legs'],distribution.price_distribution(pred['forward'],pred['total_log_volatility']),
                        row['entry_debit_points'],fee=e['fee_per_contract_usd'],
                        slippage_points=e['extra_slippage_per_contract_points'])
    assert abs(metrics['model_ev_net_usd']-row['ev'][model])<1e-6
    assert abs(metrics['max_loss_net_usd']-row['max_loss_usd'])<1e-6
    return {**row,'probability_model':model,'metrics':metrics}
