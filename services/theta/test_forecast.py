"""Synthetic quote inversion and strict cutoff tests for own range forecasts."""
import math
from datetime import date, timedelta
import unittest

from forecast import (black_straddle, calibrated_prediction, interval_metrics,
                      option_prediction, plan, preopen_prediction)


class ForecastTests(unittest.TestCase):
    def setUp(self):
        self.cfg=plan()

    def test_inverts_known_black_market_without_underlying_or_outcome(self):
        chain={}
        forward,vol=1000,.01
        for strike in range(980,1021,5):
            total=black_straddle(forward,strike,vol)
            call=(total+forward-strike)/2
            put=(total-forward+strike)/2
            for right,mid in [('call',call),('put',put)]:
                chain[(strike,right)]={'bid':mid-.005,'ask':mid+.005,'bid_size':10,'ask_size':10}
        p=option_prediction('2026-09-15',chain,self.cfg)
        self.assertAlmostEqual(p['forward'],forward,places=9)
        self.assertAlmostEqual(p['total_log_volatility'],vol,places=10)
        self.assertAlmostEqual(p['median'],forward*math.exp(-vol*vol/2),places=8)
        self.assertLess(p['bands']['95'][0],p['bands']['68'][0])
        self.assertGreater(p['bands']['95'][1],p['bands']['68'][1])

    def test_preopen_excludes_target_and_future_daily_prices(self):
        start=date(2026,1,1)
        rows=[{'date':(start+timedelta(days=i)).isoformat(),'close':100+i+(i%3)*.1} for i in range(90)]
        target=rows[70]['date']
        first=preopen_prediction(target,rows,self.cfg)
        mutated=[{**r,'close':r['close'] if r['date']<target else 999999} for r in rows]
        self.assertEqual(first,preopen_prediction(target,mutated,self.cfg))
        self.assertLess(first['input_end_date'],target)

    def test_calibration_excludes_current_and_future_scores(self):
        current={'target_date':'2026-09-15','median':1000,'total_log_volatility':.01,'quote_time_et':'10:00:00'}
        scores=[{'date':f'2026-08-{i:02d}','score':i/10} for i in range(1,21)]
        expected=calibrated_prediction(current,scores,self.cfg)
        actual=calibrated_prediction(current,scores+[{'date':'2026-09-15','score':1000},
                                                   {'date':'2026-09-16','score':1000}],self.cfg)
        self.assertEqual(actual,expected)
        self.assertEqual(expected['standardized_error_quantiles']['68'],1.5)
        self.assertEqual(expected['standardized_error_quantiles']['95'],2)
        self.assertIsNone(calibrated_prediction(current,scores[:19],self.cfg))

    def test_interval_score_penalizes_misses_and_width(self):
        predictions=[{'target_date':'2026-09-15','bands':{'95':[90,110]}}]
        inside=interval_metrics(predictions,{'2026-09-15':100},.95)
        missed=interval_metrics(predictions,{'2026-09-15':120},.95)
        self.assertEqual(inside['mean_interval_score'],20)
        self.assertAlmostEqual(missed['mean_interval_score'],420)
        self.assertEqual(missed['covered'],0)


if __name__=='__main__':
    unittest.main()
