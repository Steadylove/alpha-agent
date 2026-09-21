"""Chronological signed-residual calibration; candidate P models, not validated P."""
from __future__ import annotations

import math

import numpy as np
from scipy.optimize import brentq
from scipy.special import ndtr


def abs_normal(mean, std):
    """E|N(mean, std^2)|, vectorized and including degenerate differences."""
    mean,std = np.asarray(mean),np.asarray(std)
    safe = np.where(std>0,std,1.)
    z = mean/safe
    return np.where(std>0,2*std*np.exp(-z*z/2)/math.sqrt(2*math.pi)+mean*(2*ndtr(z)-1),np.abs(mean))


class NormalMixture:
    def __init__(self, centers, widths, measure):
        self.centers = np.asarray(centers,dtype=float)
        self.widths = np.broadcast_to(np.asarray(widths,dtype=float),self.centers.shape)
        if (self.centers.ndim!=1 or len(self.centers)==0 or not np.all(np.isfinite(self.centers))
                or not np.all(np.isfinite(self.widths)) or np.any(self.widths<=0)):
            raise ValueError('Finite centers and positive widths required')
        self.measure = measure

    def cdf(self,z):
        return float(np.mean(ndtr((z-self.centers)/self.widths)))

    def quantile(self,p):
        if not 0<=p<=1:
            raise ValueError('Probability outside [0,1]')
        if p==0:
            return -math.inf
        if p==1:
            return math.inf
        a = float(np.min(self.centers-40*self.widths))
        b = float(np.max(self.centers+40*self.widths))
        return brentq(lambda z:self.cdf(z)-p,a,b,xtol=1e-12)

    def crps(self,observed):
        first = np.mean(abs_normal(self.centers-observed,self.widths))
        differences = self.centers[:,None]-self.centers[None,:]
        widths = np.sqrt(self.widths[:,None]**2+self.widths[None,:]**2)
        return float(first-.5*np.mean(abs_normal(differences,widths)))

    def price_distribution(self,forward,total_vol):
        return LognormalMixture(math.log(forward)-total_vol**2/2+total_vol*self.centers,
                                total_vol*self.widths,self.measure)

    def description(self):
        return {'measure':self.measure,'centers':self.centers.tolist(),'widths':self.widths.tolist(),
                'weighting':'equal','standardized_mean':float(np.mean(self.centers)),
                'standardized_std':float(np.sqrt(np.mean(self.widths**2+self.centers**2)-np.mean(self.centers)**2))}


class LognormalMixture:
    """Implements density.py's probability/first_moment protocol exactly."""
    def __init__(self,mus,vols,measure):
        self.mus = np.asarray(mus,dtype=float)
        self.vols = np.asarray(vols,dtype=float)
        if (not np.all(np.isfinite(self.mus)) or not np.all(np.isfinite(self.vols))
                or not np.all(self.vols>0) or self.mus.shape != self.vols.shape):
            raise ValueError('Invalid lognormal mixture parameters')
        self.component_means = np.exp(self.mus+self.vols**2/2)
        self.measure = measure

    def _z(self,spot):
        return (math.log(spot)-self.mus)/self.vols if spot>0 else np.full_like(self.mus,-math.inf)

    def cdf(self,spot):
        return float(np.mean(ndtr(self._z(spot))))

    def quantile(self,p):
        z = NormalMixture(self.mus,self.vols,self.measure).quantile(p)
        return math.exp(z)

    def probability(self,low,high):
        if high<=low or high<=0:
            return 0.
        a,b = self._z(low),self._z(high)
        return float(np.mean(np.where(a>0,ndtr(-a)-ndtr(-b),ndtr(b)-ndtr(a))))

    def first_moment(self,low,high):
        if high<=low or high<=0:
            return 0.
        a,b = self._z(low)-self.vols,self._z(high)-self.vols
        return float(np.mean(self.component_means*np.where(a>0,ndtr(-a)-ndtr(-b),ndtr(b)-ndtr(a))))


def signed_residual(prediction,close):
    w = prediction['total_log_volatility']
    return (math.log(close/prediction['forward'])+w*w/2)/w


def fit_models(target_date,earlier,cfg):
    """Outcome filtering is intrinsic to the function, independent of the caller."""
    past = sorted((r for r in earlier if r['date']<target_date),key=lambda r:r['date'])[-cfg['maximum_training_sessions']:]
    if len({r['date'] for r in past}) != len(past):
        raise ValueError('Duplicate training dates')
    if len(past)<cfg['minimum_training_sessions']:
        return None
    values = np.array([r['z'] for r in past])
    if not np.all(np.isfinite(values)):
        raise ValueError('Non-finite historical residual')
    std = float(np.std(values,ddof=1))
    if std<=1e-8:
        raise ValueError('Degenerate signed-residual sample')
    mean = float(np.mean(values))
    bandwidth = 1.06*std*len(values)**(-.2)
    models = {'Q0':NormalMixture([0.],[1.],'Q0_market_lognormal_approximation'),
              'P_normal':NormalMixture([mean],[std],'P_candidate_rolling_normal_unvalidated'),
              'P_kernel':NormalMixture(values,bandwidth,'P_candidate_rolling_kernel_unvalidated')}
    metadata = {'training_dates':[r['date'] for r in past], 'count':len(past),
                'sample_mean':mean,'sample_std':std,'kernel_bandwidth':bandwidth}
    return models,metadata


def score_distribution(model,observed_z,forward,total_vol,close,coverages):
    price = model.price_distribution(forward,total_vol)
    bands = {}
    for coverage in coverages:
        low = price.quantile((1-coverage)/2)
        high = price.quantile((1+coverage)/2)
        bands[str(round(100*coverage))] = {'low':low,'high':high,'covered':low<=close<=high,
            'width_points':high-low,'interval_score_points':high-low+2/(1-coverage)*max(low-close,close-high,0.)}
    p_above = 1-model.cdf(0.)
    p_tail = model.cdf(-1.959963984540054)+1-model.cdf(1.959963984540054)
    return {'standardized_crps':model.crps(observed_z),'pit':model.cdf(observed_z),
            'brier_above_q0_median':(p_above-float(observed_z>0))**2,
            'brier_outside_q0_95':(p_tail-float(abs(observed_z)>1.959963984540054))**2,
            'predicted_above_q0_median':p_above,'predicted_outside_q0_95':p_tail,'bands':bands}
