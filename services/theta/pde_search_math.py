"""E03: interval-constrained market density and earlier-only P candidates."""
import math
from statistics import median

import numpy as np
from scipy import sparse
from scipy.optimize import brentq, linprog
from scipy.special import ndtr

from calibration import abs_normal
from density import Lognormal

# Official 2025 Nasdaq holiday notices ETA2025-92 and ETA2025-101;
# SPXW cash expiry follows the cash close. No early closes in Jan-Sep 2026.
CASH_EARLY_CLOSE = {'2025-11-28': '13:00:00', '2025-12-24': '13:00:00'}


class WeightedNormal:
    def __init__(self, centers, widths, weights, measure):
        self.centers=np.asarray(centers,dtype=float)
        self.widths=np.broadcast_to(np.asarray(widths,dtype=float),self.centers.shape).copy()
        self.weights=np.asarray(weights,dtype=float)
        if (self.centers.ndim!=1 or not len(self.centers) or self.weights.shape!=self.centers.shape
                or not np.all(np.isfinite(self.centers)) or not np.all(np.isfinite(self.widths))
                or not np.all(np.isfinite(self.weights)) or np.any(self.widths<=0)
                or np.any(self.weights<0) or self.weights.sum()<=0):
            raise ValueError('Invalid weighted normal mixture')
        self.weights=self.weights/self.weights.sum()
        self.measure=measure

    def cdf(self,z):
        return float(self.weights@ndtr((z-self.centers)/self.widths))

    def quantile(self,p):
        if not 0<=p<=1:
            raise ValueError('Probability outside [0,1]')
        if p==0:
            return -math.inf
        if p==1:
            return math.inf
        return brentq(lambda z:self.cdf(z)-p,float(np.min(self.centers-12*self.widths)),
                      float(np.max(self.centers+12*self.widths)),xtol=1e-11)

    def crps(self,z):
        first=self.weights@abs_normal(self.centers-z,self.widths)
        distances=abs_normal(self.centers[:,None]-self.centers[None,:],
                             np.sqrt(self.widths[:,None]**2+self.widths[None,:]**2))
        return float(first-.5*self.weights@distances@self.weights)

    def price_distribution(self,forward,vol):
        return WeightedLognormal(math.log(forward)-vol**2/2+vol*self.centers,
                                  vol*self.widths,self.weights,self.measure)

    def description(self):
        return {'centers':self.centers.tolist(),'widths':self.widths.tolist(),
                'weights':self.weights.tolist(),'measure':self.measure}


class WeightedLognormal:
    def __init__(self,mus,vols,weights,measure):
        self.mus=np.asarray(mus);self.vols=np.asarray(vols);self.weights=np.asarray(weights)
        self.means=np.exp(self.mus+self.vols**2/2);self.measure=measure

    def _z(self,s):
        return (math.log(s)-self.mus)/self.vols if s>0 else np.full_like(self.mus,-math.inf)

    def cdf(self,s):
        return float(self.weights@ndtr(self._z(s)))

    def quantile(self,p):
        return math.exp(WeightedNormal(self.mus,self.vols,self.weights,self.measure).quantile(p))

    def probability(self,low,high):
        if high<=low or high<=0:
            return 0.
        a,b=self._z(low),self._z(high)
        return float(self.weights@np.where(a>0,ndtr(-a)-ndtr(-b),ndtr(b)-ndtr(a)))

    def first_moment(self,low,high):
        if high<=low or high<=0:
            return 0.
        a,b=self._z(low)-self.vols,self._z(high)-self.vols
        return float((self.weights*self.means)@np.where(a>0,ndtr(-a)-ndtr(-b),ndtr(b)-ndtr(a)))

    def expected_options(self,strikes,rights):
        k=np.asarray(strikes)[:,None]
        d2=(self.mus[None,:]-np.log(k))/self.vols[None,:]
        calls=(self.means[None,:]*ndtr(d2+self.vols[None,:])-k*ndtr(d2))@self.weights
        return np.where(np.asarray(rights)=='call',calls,calls-np.dot(self.weights,self.means)+k[:,0])


class DiscreteMarket:
    def __init__(self,support,mass,forward,vol):
        self.support=np.asarray(support);self.mass=np.asarray(mass)
        self.forward=forward;self.vol=vol
        self.z=(np.log(self.support/forward)+vol*vol/2)/vol

    def expected_options(self,strikes,rights):
        k=np.asarray(strikes)[:,None]
        payoffs=np.where((np.asarray(rights)=='call')[:,None],
                         np.maximum(self.support-k,0),np.maximum(k-self.support,0))
        return payoffs@self.mass

    def cdf(self,s):
        return float(self.mass[self.support<=s].sum())

    def quantile(self,p):
        return float(self.support[min(len(self.mass)-1,np.searchsorted(np.cumsum(self.mass),p))])

    def crps(self,z):
        first=float(self.mass@np.abs(self.z-z))
        return first-.5*float(self.mass@np.abs(self.z[:,None]-self.z[None,:])@self.mass)


def fit_market(chain,pred,cfg):
    f,w=pred['forward'],pred['total_log_volatility'];scale=f*w
    mc=cfg['market_density'];atm=Lognormal(f,w)
    strikes=sorted({k for (k,right) in chain if abs(k-f)<=4*scale})
    support=np.array(sorted(set([atm.quantile(.000001),*strikes,atm.quantile(.999999)])))
    if len(support)<12 or not support[0]<f<support[-1]:
        raise ValueError('Insufficient market-density strike support')
    quotes=[]
    for (strike,right),q in sorted(chain.items()):
        if (abs(strike-f)<=mc['strike_window_original_sigma']*scale
                and 0<q['bid']<=q['ask'] and q['bid_size']>=1 and q['ask_size']>=1
                and q['ask']-q['bid']<=mc['maximum_fitted_leg_spread_points']+1e-9):
            quotes.append((strike,right,q))
    if len(quotes)<12:
        raise ValueError('Insufficient liquid smile quotes')
    k=np.array([q[0] for q in quotes])[:,None]
    calls=np.array([q[1]=='call' for q in quotes])[:,None]
    payoff=np.where(calls,np.maximum(support-k,0),np.maximum(k-support,0))/scale
    bid=np.array([q[2]['bid'] for q in quotes])/scale
    ask=np.array([q[2]['ask'] for q in quotes])/scale
    boundaries=[0.,*((support[:-1]+support[1:])/2),math.inf]
    prior=np.array([atm.probability(a,b) for a,b in zip(boundaries,boundaries[1:])])
    n,m=len(support),len(quotes)
    I=sparse.eye(n,format='csr');J=sparse.eye(m,format='csr')
    A=sparse.vstack([sparse.hstack([sparse.csr_matrix(payoff),-J,sparse.csr_matrix((m,n))]),
                     sparse.hstack([-sparse.csr_matrix(payoff),-J,sparse.csr_matrix((m,n))]),
                     sparse.hstack([I,sparse.csr_matrix((n,m)),-I]),
                     sparse.hstack([-I,sparse.csr_matrix((n,m)),-I])],format='csr')
    b=np.r_[ask,-bid,prior,-prior]
    costs=np.r_[np.zeros(n),np.full(m,scale/m),np.full(n,mc['prior_regularization_points'])]
    equal=sparse.csr_matrix(np.vstack([np.r_[np.ones(n),np.zeros(m+n)],
                                      np.r_[(support-f)/scale,np.zeros(m+n)]]))
    solution=linprog(costs,A_ub=A,b_ub=b,A_eq=equal,b_eq=[1.,0.],bounds=(0,None),method='highs')
    if not solution.success:
        raise ValueError('Market probability optimization failed: '+solution.message)
    mass=np.maximum(solution.x[:n],0);mass/=mass.sum()
    fitted=payoff@mass*scale
    bids,asks=bid*scale,ask*scale
    violation=np.maximum.reduce([bids-fitted,fitted-asks,np.zeros(m)])
    normalized=float(np.mean(violation/np.maximum(asks-bids,.05)))
    info={'quote_count':m,'support_size':n,'support_low':float(support[0]),'support_high':float(support[-1]),
          'mean_quote_violation_points':float(violation.mean()),'max_quote_violation_points':float(violation.max()),
          'mean_normalized_quote_violation':normalized,'mass':float(mass.sum()),
          'forward_error':float(mass@support-f),'discrete_tail_assumption':True}
    if normalized>mc['maximum_normalized_mean_quote_violation'] or violation.max()>mc['maximum_single_quote_violation_points']:
        raise ValueError('Smile quotes inconsistent with declared fitting tolerances: '+str(info))
    return DiscreteMarket(support,mass,f,w),info


def black_option(f,k,w,right):
    if w<=0:
        return max(f-k,0) if right=='call' else max(k-f,0)
    d1=math.log(f/k)/w+w/2;d2=d1-w
    return f*ndtr(d1)-k*ndtr(d2) if right=='call' else k*ndtr(-d2)-f*ndtr(-d1)


def state_features(day,expiry,stamp,chain,pred,daily_rows):
    past=[r for r in daily_rows if r['date']<day][-21:]
    if len(past)<21:
        raise ValueError('Insufficient prior realized-volatility data')
    rv=float(np.std([math.log(b['close']/a['close']) for a,b in zip(past,past[1:])],ddof=1))
    f,w=pred['forward'],pred['total_log_volatility']
    # Calendar horizon is known at entry; not a claim that overnight variance is constant.
    from datetime import datetime, timezone
    from provider import ET
    close_time=CASH_EARLY_CLOSE.get(expiry,'16:00:00')
    finish=datetime.fromisoformat(expiry+'T'+close_time).replace(tzinfo=ET).astimezone(timezone.utc)
    begin=datetime.fromisoformat(day+'T'+stamp).replace(tzinfo=ET).astimezone(timezone.utc)
    hours=(finish-begin).total_seconds()/3600
    if rv<=0 or hours<=0:
        raise ValueError('Invalid variance horizon')
    ratio=math.log(w/(rv*math.sqrt(hours/24)))
    vols=[]
    for right,direction in [('put',-1),('call',1)]:
        target=f*math.exp(direction*w)
        candidates=sorted([(abs(k-target),k,q) for (k,r),q in chain.items() if r==right
                           and 0<q['bid']<=q['ask'] and q['ask']-q['bid']<=1.+1e-9
                           and q['bid_size']>=1 and q['ask_size']>=1],key=lambda x:x[0])
        if not candidates or candidates[0][0]>f*w*.4:
            raise ValueError('Missing one-sigma skew quote')
        _,k,q=candidates[0];premium=(q['bid']+q['ask'])/2
        if premium<=black_option(f,k,0,right):
            raise ValueError('Invalid skew option price')
        vols.append(brentq(lambda v:black_option(f,k,v,right)-premium,1e-8,3.))
    return [ratio,math.log(vols[0]/vols[1])],{'rv20_prior':rv,'last_daily_input':past[-1]['date'],
                                          'skew_put_total_vol':vols[0],'skew_call_total_vol':vols[1],
                                          'calendar_hours_to_expiry':hours}


def fit_probability(day,earlier,features,cfg):
    # Next-day outcomes become available only after expiry, never on the entry day.
    past=sorted((r for r in earlier if r['expiration']<day),key=lambda r:r['date'])[-cfg['maximum_training_sessions']:]
    if len(past)<cfg['minimum_training_sessions']:
        return None
    z=np.array([r['z'] for r in past]);std=float(z.std(ddof=1))
    if std<=1e-8:
        return None
    h=1.06*std*len(z)**(-.2);uniform=np.full(len(z),1/len(z))
    models={'P_normal':WeightedNormal([float(z.mean())],[std],[1.],'P_normal_candidate'),
            'P_kernel':WeightedNormal(z,h,uniform,'P_kernel_candidate')}
    xs=np.array([r['features'] for r in past]);scales=np.maximum(xs.std(axis=0,ddof=1),1e-6)
    distances=np.sum(((xs-np.asarray(features))/scales/cfg['state_model']['feature_bandwidth'])**2,axis=1)
    log_weights=-.5*distances;log_weights-=log_weights.max();local=np.exp(log_weights);local/=local.sum()
    g=cfg['state_model']['global_weight'];weights=g*uniform+(1-g)*local
    effective=1/float(weights@weights)
    if effective<cfg['state_model']['minimum_effective_sample_size']:
        weights=uniform;effective=float(len(z))
    models['P_state']=WeightedNormal(z,h,weights,'P_state_IV_RV_skew_candidate')
    return models,{'training_dates':[r['date'] for r in past],
                   'training_expirations':[r['expiration'] for r in past],
                   'last_matured_expiry':max(r['expiration'] for r in past),'count':len(past),
                   'state_effective_sample_size':effective,'kernel_bandwidth':h}


def choose_probability(day,previous,cfg):
    past=sorted((r for r in previous if r['expiration']<day),key=lambda r:r['date'])[-cfg['model_selection']['validation_maximum_sessions']:]
    if len(past)<cfg['model_selection']['validation_minimum_sessions']:
        return None
    averages={name:float(np.mean([r['scores'][name]['crps'] for r in past]))
              for name in ['Q_market',*cfg['probability_models']]}
    best=min(cfg['probability_models'],key=lambda name:averages[name])
    return {'model':best,'passes_quality_gate':averages[best]<averages['Q_market'],
            'validation_dates':[r['date'] for r in past],
            'validation_expirations':[r['expiration'] for r in past],'mean_crps':averages}
