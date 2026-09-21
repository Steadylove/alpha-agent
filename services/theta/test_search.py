"""Meaningful E03 invariants: no manufactured edge or future/overlap leakage."""
from datetime import date, timedelta
import json
import math
import unittest

import numpy as np
from scipy.integrate import quad

from density import Lognormal, terminal_payoff
from pde_search_data import PLAN
from pde_search_math import WeightedNormal, fit_market, fit_probability, choose_probability, black_option
from pde_search_optimizer import generate_structures, price_candidates, select_candidates, enrich_selected
from pde_search import replay_policy, aggregate


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.cfg=json.loads(PLAN.read_text())
        self.pred={'forward':7500.,'total_log_volatility':.01,'median':7500*math.exp(-.01**2/2)}
        self.chain={}
        for strike in range(7150,7851,5):
            for right in ('call','put'):
                price=float(black_option(7500,strike,.01,right))
                self.chain[(strike,right)]={'bid':max(.00001,price-.04),'ask':max(.08001,price+.04),
                    'bid_size':50,'ask_size':50}

    def test_weighted_crps_and_option_integrals(self):
        model=WeightedNormal([-1.,.2,1.7],[.4,.7,.3],[.1,.6,.3],'test')
        x=.5
        independent=quad(lambda z:model.cdf(z)**2,-20,x,epsabs=1e-10)[0]
        independent+=quad(lambda z:(1-model.cdf(z))**2,x,20,epsabs=1e-10)[0]
        self.assertAlmostEqual(model.crps(x),independent,places=9)
        p=model.price_distribution(7500,.01)
        actual=p.expected_options([7475,7525],['put','call'])
        independent=[]
        for k,right in [(7475,'put'),(7525,'call')]:
            expected=sum(weight*black_option(math.exp(mu+vol*vol/2),k,vol,right)
                         for weight,mu,vol in zip(p.weights,p.mus,p.vols))
            independent.append(expected)
        np.testing.assert_allclose(actual,independent,rtol=1e-10,atol=1e-9)
        self.assertAlmostEqual(p.probability(0,math.inf),1.)

    def test_market_density_is_a_probability_and_respects_prices(self):
        market,diagnostics=fit_market(self.chain,self.pred,self.cfg)
        self.assertTrue(np.all(market.mass>=0))
        self.assertAlmostEqual(float(market.mass.sum()),1.,places=10)
        self.assertAlmostEqual(float(market.mass@market.support),7500.,places=7)
        self.assertLess(diagnostics['max_quote_violation_points'],1e-6)
        prices=market.expected_options(list(range(7400,7601,5)),['call']*41)
        self.assertTrue(np.all(np.diff(prices)<=1e-7))
        self.assertTrue(np.all(np.diff(prices,n=2)>=-1e-7))

    def test_known_market_has_no_positive_edge_after_costs(self):
        market,_=fit_market(self.chain,self.pred,self.cfg)
        model=WeightedNormal([0.],[1.],[1.],'known_Q')
        models={name:model for name in self.cfg['probability_models']}
        rows,diagnostics=price_candidates(self.pred,market,models,self.chain,self.cfg)
        self.assertGreater(diagnostics['generated'],100)
        self.assertGreater(len(rows),10)
        for row in rows:
            self.assertLess(row['ev']['P_kernel'],0)
        self.assertIsNone(select_candidates(rows,'P_kernel',{'passes_quality_gate':True},self.cfg))

    def test_training_waits_for_expiry_and_ignores_future_outcomes(self):
        start=date(2025,1,1)
        history=[{'date':(start+timedelta(days=i)).isoformat(),
                  'expiration':(start+timedelta(days=i+1)).isoformat(),
                  'z':math.sin(i),'features':[math.sin(i/10),math.cos(i/10)]} for i in range(130)]
        target=history[100]['date']
        first,meta=fit_probability(target,history,[0,0],self.cfg)
        poisoned=[r if r['expiration']<target else {**r,'z':1e8,'features':[1e8,1e8]} for r in history]
        second,other=fit_probability(target,poisoned,[0,0],self.cfg)
        self.assertEqual(meta,other)
        self.assertEqual(meta['count'],99)
        self.assertTrue(all(expiry<target for expiry in meta['training_expirations']))
        self.assertEqual({n:m.description() for n,m in first.items()},
                         {n:m.description() for n,m in second.items()})

    def test_model_choice_is_based_on_matured_forecast_scores(self):
        start=date(2025,1,1)
        history=[]
        for i in range(45):
            history.append({'date':(start+timedelta(days=i)).isoformat(),
                 'expiration':(start+timedelta(days=i+1)).isoformat(),
                 'scores':{name:{'crps':score} for name,score in
                           [('Q_market',.6),('P_normal',.7),('P_kernel',.5),('P_state',.55)]}})
        target=history[30]['date'];first=choose_probability(target,history,self.cfg)
        poisoned=[r if r['expiration']<target else {**r,'scores':{n:{'crps':-1e6 if n=='P_state' else 1e6} for n in r['scores']}} for r in history]
        self.assertEqual(first,choose_probability(target,poisoned,self.cfg))
        self.assertEqual(first['model'],'P_kernel');self.assertTrue(first['passes_quality_gate'])

    def test_quality_gate_and_cost_threshold_are_required(self):
        row={'family':'iron_condor','ev':{'P_kernel':11.,'Q_market':-10.},
             'p_minus_q_expected_payoff_usd':{'P_kernel':21.},'max_loss_usd':900.}
        self.assertIsNone(select_candidates([row],'P_kernel',{'passes_quality_gate':True},self.cfg))
        row['ev']['P_kernel']=30.
        self.assertIsNone(select_candidates([row],'P_kernel',{'passes_quality_gate':False},self.cfg))
        self.assertEqual(select_candidates([row],'P_kernel',{'passes_quality_gate':True},self.cfg),row)
        row['ev']['Q_market']=5.
        self.assertIsNone(select_candidates([row],'P_kernel',{'passes_quality_gate':True},self.cfg))

    def test_first_time_and_existing_position_cannot_use_future_best_trade(self):
        legs=[{'strike':7500,'right':'put','qty':1},{'strike':7490,'right':'put','qty':-1}]
        def row(day,time,expiry,ev):
            c={'family':'put_debit','legs':legs,'entry_debit_points':4.,'opening_fees_usd':3.,
               'extra_slippage_usd':4.,'contract_count':2,'max_loss_usd':407.,'max_profit_usd':593.,
               'probability_model':'P_kernel','ev':{'P_kernel':ev}}
            return {'date':day,'time':time,'expiration':expiry,'offset':int(expiry!=day),
                    'quality':{'model':'P_kernel','passes_quality_gate':True},
                    'selected':{p:c for p in self.cfg['policies']}}
        rows=[row('2026-05-28','10:00:00','2026-05-29',20.),row('2026-05-28','14:00:00','2026-05-28',1000.),
              row('2026-05-29','10:00:00','2026-05-29',1000.),row('2026-06-01','11:00:00','2026-06-01',20.)]
        closes={'2026-05-28':7495.,'2026-05-29':7495.,'2026-06-01':7495.}
        result=replay_policy(rows,'primary_quality_gated',self.cfg,closes)
        self.assertEqual([(r['date'],r['time']) for r in result['trades']],
                         [('2026-05-28','10:00:00'),('2026-06-01','11:00:00')])
        summaries=aggregate(rows,self.cfg,closes)
        self.assertEqual(sum(summaries[s]['primary_quality_gated']['summary']['trades'] for s in ['development','evaluation']),2)
        self.assertAlmostEqual(result['trades'][0]['net_pnl_usd'],93.)

    def test_all_generated_structures_have_bounded_call_tails(self):
        market,_=fit_market(self.chain,self.pred,self.cfg)
        for row in generate_structures(self.pred,market,self.cfg):
            legs=row['legs'];above=max(l['strike'] for l in legs)+1
            self.assertAlmostEqual(terminal_payoff(legs,above),terminal_payoff(legs,above+1e6),places=5)

    def test_missing_quotes_are_counted_as_no_trade_sessions(self):
        result=replay_policy([],'primary_quality_gated',self.cfg,{'2026-06-01':7500.,'2026-06-02':7510.})
        self.assertEqual(result['decision_days'],2)
        self.assertEqual(result['trades'],[])
        self.assertEqual(len(result['decisions']),6)
        self.assertTrue(all(r['reason']=='no_usable_snapshot' for r in result['decisions']))


if __name__=='__main__':
    unittest.main()
