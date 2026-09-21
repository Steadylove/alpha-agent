"""Time cutoff, distribution scoring, mixture pricing and selection invariants."""
from datetime import date,timedelta
import json
import math
from statistics import NormalDist
import unittest

from scipy.integrate import quad

from calibration import NormalMixture, fit_models
from density import Lognormal, pnl_metrics
from pde import black_price
from pde_calibrate import paired_block_interval, select_candidate
from pde_history import PLAN


class CalibrationTests(unittest.TestCase):
    def setUp(self):
        self.cfg = json.loads(PLAN.read_text())
        start = date(2025,1,1)
        self.history = [{'date':(start+timedelta(days=i)).isoformat(),'z':math.sin(i)*.8+i%7*.1} for i in range(150)]

    def test_future_and_current_outcomes_cannot_change_fit(self):
        target = self.history[130]['date']
        first,meta = fit_models(target,self.history,self.cfg)
        mutated = [r if r['date']<target else {**r,'z':9999999} for r in self.history]
        second,other = fit_models(target,mutated,self.cfg)
        self.assertEqual(meta,other)
        self.assertEqual(meta['count'],120)
        self.assertEqual(meta['training_dates'],[r['date'] for r in self.history[10:130]])
        for name in first:
            self.assertEqual(first[name].description(),second[name].description())

    def test_warmup_and_degenerate_training_are_not_predictions(self):
        self.assertIsNone(fit_models(self.history[59]['date'],self.history,self.cfg))
        self.assertIsNotNone(fit_models(self.history[60]['date'],self.history,self.cfg))
        with self.assertRaises(ValueError):
            fit_models(self.history[80]['date'],[{**r,'z':0.} for r in self.history],self.cfg)

    def test_crps_matches_normal_identity_and_independent_cdf_integral(self):
        normal = NormalMixture([0.],[1.],'test')
        self.assertAlmostEqual(normal.crps(0),(math.sqrt(2)-1)/math.sqrt(math.pi),places=12)
        mixture = NormalMixture([-2.,.1,1.5],[.5,.8,.2],'test')
        observed = .6
        independent = quad(lambda x:mixture.cdf(x)**2,-15,observed,epsabs=1e-10)[0]
        independent += quad(lambda x:(1-mixture.cdf(x))**2,observed,15,epsabs=1e-10)[0]
        self.assertAlmostEqual(mixture.crps(observed),independent,places=9)

    def test_mixture_probability_moments_and_quantile(self):
        z = NormalMixture([-1,0,2],[.3,.3,.3],'test')
        mixture = z.price_distribution(7500.,.01)
        self.assertEqual(mixture.probability(0,math.inf),1.)
        means = [math.exp(math.log(7500)-.01**2/2+.01*m+(.01*.3)**2/2) for m in (-1,0,2)]
        self.assertAlmostEqual(mixture.first_moment(0,math.inf),sum(means)/3,places=10)
        for p in (.01,.16,.5,.84,.975):
            self.assertAlmostEqual(mixture.cdf(mixture.quantile(p)),p,places=10)
        self.assertNotAlmostEqual(z.cdf(-1.5),1-z.cdf(1.5),places=2)

    def test_single_component_price_distribution_matches_frozen_q0(self):
        actual = NormalMixture([0.],[1.],'test').price_distribution(7500.,.01)
        expected = Lognormal(7500.,.01)
        for low,high in ((0,math.inf),(7400,7520),(7550,math.inf)):
            self.assertAlmostEqual(actual.probability(low,high),expected.probability(low,high),places=12)
            self.assertAlmostEqual(actual.first_moment(low,high),expected.first_moment(low,high),places=9)

    def test_known_mixture_market_does_not_create_alpha(self):
        mixture = NormalMixture([-1,0,2],[.4,.4,.4],'synthetic').price_distribution(7500,.01)
        legs = [{'strike':7465,'right':'call','qty':1},{'strike':7500,'right':'call','qty':-2},
                {'strike':7535,'right':'call','qty':1}]
        mids = []
        for leg in legs:
            mids.append(sum(black_price(float(f),float(v),leg['strike'],leg['right'],1.)
                            for f,v in zip(mixture.component_means,mixture.vols))/3)
        debit = sum(leg['qty']*price for leg,price in zip(legs,mids))
        metrics = pnl_metrics(legs,mixture,debit,fee=0)
        self.assertAlmostEqual(metrics['model_ev_net_usd'],0,places=7)

    def test_selector_uses_cost_stress_and_total_risk(self):
        probe = self.cfg['economic_probe']
        def row(name,ev,risk):
            return {'candidate':name,'status':'priced','contract_count':4,'metrics':{
                'model_ev_net_usd':ev,'max_loss_net_usd':risk,'net_pnl_max_usd':100.,'p_profit':.9}}
        self.assertEqual(select_candidate([row('too_expensive',7.,900)],probe)['candidate'],'no_trade')
        self.assertEqual(select_candidate([row('too_risky',20.,996)],probe)['candidate'],'no_trade')
        rows = [row('first',20.,800),row('second',18.,400)]
        chosen = select_candidate(rows,probe)
        self.assertEqual(chosen['candidate'],'second')
        self.assertEqual(chosen['modeled_stressed_ev_usd'],10.)
        self.assertEqual(chosen['stressed_max_loss_usd'],408.)
        for row in rows:
            row['observed_stressed_pnl_usd'] = 1e9 if row['candidate']=='first' else -1e9
        self.assertEqual(select_candidate(rows,probe),chosen)

    def test_block_resampling_is_reproducible_and_preserves_constant_difference(self):
        a = paired_block_interval([2.]*20,self.cfg['bootstrap'])
        self.assertEqual(a['approximate_95pct_interval'],[2.,2.])
        self.assertEqual(a,paired_block_interval([2.]*20,self.cfg['bootstrap']))


if __name__=='__main__':
    unittest.main()
