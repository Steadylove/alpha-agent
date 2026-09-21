"""Closed-form probability, cashflow and payoff-atom regression tests."""
import math
from statistics import NormalDist
import unittest

from scipy.integrate import quad

from density import Lognormal, pnl_metrics, terminal_payoff
from pde import analyze_day, black_price, candidates, negative_control, plan


def leg(strike, right, qty):
    return {'strike': strike, 'right': right, 'qty': qty}


class DensityTests(unittest.TestCase):
    def setUp(self):
        self.dist = Lognormal(100., .2, 'synthetic_test')

    def test_probability_domain_quantiles_and_first_moment(self):
        self.assertEqual(self.dist.probability(0, math.inf), 1.)
        self.assertEqual(self.dist.first_moment(0, math.inf), 100.)
        self.assertEqual(self.dist.probability(-10, -1), 0.)
        self.assertEqual(self.dist.quantile(0), 0.)
        self.assertEqual(self.dist.quantile(1), math.inf)
        for p in (.000001, .01, .16, .5, .84, .95, .999999):
            self.assertAlmostEqual(self.dist.cdf(self.dist.quantile(p)), p, places=13)
        # A CDF subtraction would round this right-tail mass to zero.
        self.assertGreater(self.dist.probability(math.exp(self.dist.mu + 9*.2), math.inf), 0.)

    def test_vertical_cashflow_sign_and_profit_probability(self):
        legs = [leg(90, 'put', -1), leg(80, 'put', 1)]
        m = pnl_metrics(legs, self.dist, debit_points=-2., fee=1.5)
        self.assertEqual(m['net_pnl_min_usd'], -803.)
        self.assertEqual(m['net_pnl_max_usd'], 197.)
        self.assertEqual(m['net_breakevens'], [88.03])
        self.assertAlmostEqual(m['p_profit'], 1-self.dist.cdf(88.03))
        self.assertAlmostEqual(m['p_minimum_pnl'], self.dist.cdf(80))
        self.assertAlmostEqual(m['p_maximum_pnl'], 1-self.dist.cdf(90))
        self.assertEqual(m['p_breakeven'], 0.)

    def test_expected_shortfall_fractionally_consumes_max_loss_atom(self):
        legs = [leg(90, 'put', -1), leg(80, 'put', 1)]
        m = pnl_metrics(legs, self.dist, -2., fee=1.5, tail_probability=.05)
        self.assertGreater(m['p_minimum_pnl'], .05)
        self.assertAlmostEqual(m['lower_pnl_quantile_usd'], -803., places=8)
        self.assertAlmostEqual(m['worst_tail_mean_pnl_usd'], -803., places=8)
        self.assertAlmostEqual(m['expected_shortfall_loss_usd'], 803., places=8)

    def test_butterfly_maximum_at_single_point_has_zero_probability(self):
        legs = [leg(90, 'call', 1), leg(100, 'call', -2), leg(110, 'call', 1)]
        m = pnl_metrics(legs, self.dist, 2., fee=0)
        self.assertEqual(m['max_loss_net_usd'], 200.)
        self.assertEqual(m['max_profit_net_usd'], 800.)
        self.assertEqual(m['net_breakevens'], [92., 108.])
        self.assertEqual(m['p_maximum_pnl'], 0.)
        self.assertAlmostEqual(m['p_profit'], self.dist.probability(92, 108))

    def test_condor_maximum_is_probability_mass_over_plateau(self):
        legs = [leg(80, 'put', 1), leg(90, 'put', -1), leg(110, 'call', -1), leg(120, 'call', 1)]
        m = pnl_metrics(legs, self.dist, -2., fee=0)
        self.assertAlmostEqual(m['p_maximum_pnl'], self.dist.probability(90, 110))
        self.assertEqual(m['net_breakevens'], [88., 112.])
        self.assertAlmostEqual(m['p_profit'], self.dist.probability(88, 112))
        self.assertEqual(m['max_loss_net_usd'], 800.)

    def test_exact_ev_matches_independent_quadrature(self):
        legs = [leg(90, 'call', 1), leg(100, 'call', -2), leg(110, 'call', 1)]
        m = pnl_metrics(legs, self.dist, 2., fee=1.5, slippage_points=.02, discount=.997)
        n = NormalDist()
        mu, vol = math.log(100)-.2**2/2, .2
        payoff = lambda z: (.997*terminal_payoff(legs, math.exp(mu+vol*z))-214.)*n.pdf(z)
        cuts = [-12.] + [(math.log(k)-mu)/vol for k in (90,100,110)] + [12.]
        expected = sum(quad(payoff, a, b, epsabs=1e-8)[0] for a,b in zip(cuts,cuts[1:]))
        self.assertAlmostEqual(m['model_ev_net_usd'], expected, places=8)
        self.assertAlmostEqual(m['expected_gain_usd']-m['expected_loss_usd'], expected, places=8)
        self.assertEqual(m['opening_fees_usd'], 6.)
        self.assertEqual(m['extra_slippage_usd'], 8.)

    def test_no_trade_and_zero_profit_plateau(self):
        zero = pnl_metrics([], self.dist, 0., fee=0)
        self.assertEqual(zero['p_breakeven'], 1.)
        self.assertEqual(zero['p_profit'], 0.)
        self.assertEqual(zero['p_loss'], 0.)
        self.assertEqual(zero['model_ev_net_usd'], 0.)
        self.assertEqual(zero['expected_shortfall_loss_usd'], 0.)
        vertical = pnl_metrics([leg(100,'call',1),leg(110,'call',-1)], self.dist, 0., fee=0)
        self.assertAlmostEqual(vertical['p_breakeven'], self.dist.cdf(100))
        self.assertEqual(vertical['p_loss'], 0.)
        self.assertEqual(vertical['conditional_mean_loss_usd'], None)

    def test_rejects_unsupported_payoffs_and_bad_parameters(self):
        for legs in ([leg(100,'call',-1)], [leg(100,'call',1),leg(100,'call',-1)],
                     [leg(100,'call',.5)], [leg(-1,'put',1)]):
            with self.assertRaises(ValueError):
                pnl_metrics(legs, self.dist, 1.)
        for values in ((-1,.2), (100,0), (math.nan,.2)):
            with self.assertRaises(ValueError):
                Lognormal(*values)
        for kwargs in ({'fee': -1}, {'discount': 0}, {'tail_probability': 1}, {'slippage_points': -1}):
            with self.assertRaises(ValueError):
                pnl_metrics([], self.dist, 0., **kwargs)


class PdeControlsTests(unittest.TestCase):
    def setUp(self):
        self.cfg = plan()
        self.dist = Lognormal(7500., .01)
        self.pred = {'forward': 7500., 'total_log_volatility': .01, 'median': self.dist.quantile(.5),
                     'bands': {k: [self.dist.quantile((1-float(k)/100)/2),
                                   self.dist.quantile((1+float(k)/100)/2)] for k in ('68','95')}}
        self.chain = {}
        for legs in candidates(self.pred, self.cfg).values():
            for l in legs:
                p = black_price(7500.,.01,l['strike'],l['right'],1.)
                self.chain[(l['strike'],l['right'])] = {'bid':p-.01,'ask':p+.01,'bid_size':10,'ask_size':10}

    def test_all_synthetic_zero_alpha_controls(self):
        result = negative_control(self.cfg)
        self.assertEqual(result['case_count'], 28)
        self.assertLess(result['max_abs_zero_cost_ev_usd'], 2e-7)

    def test_natural_pricing_costs_and_no_trade_decision(self):
        rows = analyze_day('synthetic', self.pred, self.chain, self.cfg)
        self.assertEqual(len(rows), 7)
        for r in rows:
            self.assertEqual(r['status'], 'priced')
            self.assertEqual(r['decision'], 'NO_TRADE_RESEARCH_ONLY')
            self.assertAlmostEqual(r['metrics']['model_ev_net_usd'], -2.5*r['contract_count'], places=7)
            self.assertAlmostEqual(r['natural_minus_mid_cost_usd'], r['contract_count'], places=7)
            self.assertAlmostEqual(r['cost_stress_ev_usd'], -4.5*r['contract_count'], places=7)

    def test_butterfly_requires_two_short_contracts_in_displayed_depth(self):
        center = candidates(self.pred,self.cfg)['call_butterfly_35'][1]['strike']
        self.chain[(center,'call')]['bid_size'] = 1
        row = analyze_day('synthetic',self.pred,self.chain,self.cfg)[0]
        self.assertEqual(row['status'], 'skipped')
        self.assertIn('size unavailable', row['reason'])

    def test_missing_protection_quote_skips_entire_candidate(self):
        wing = candidates(self.pred,self.cfg)['call_butterfly_35'][0]
        self.chain.pop((wing['strike'],wing['right']))
        self.assertEqual(analyze_day('synthetic',self.pred,self.chain,self.cfg)[0]['status'], 'skipped')


if __name__ == '__main__':
    unittest.main()
