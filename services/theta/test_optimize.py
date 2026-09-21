"""Hand-calculated cashflows, delayed exits and indivisible contract risk sizing."""
import unittest

from intraday import inputs
from optimize import close_quote, entry_metrics, liquidation_marks, position_size, simulate_exit


def q(bid, ask, size=10):
    return {'bid': bid, 'ask': ask, 'bid_size': size, 'ask_size': size}


def trade(spot=105):
    legs = [{'strike': 95, 'right': 'put', 'qty': 1}, {'strike': 100, 'right': 'put', 'qty': -1},
            {'strike': 110, 'right': 'call', 'qty': -1}, {'strike': 115, 'right': 'call', 'qty': 1}]
    return {'date': '2026-09-14', 'legs': legs, 'width': 5, 'settlement_price': spot,
            'debit_usd': -200, 'side_credits_usd': [100,100],
            'entry_quotes': [{**l, **q(.1,.2)} if l['qty'] > 0 else {**l, **q(1.2,1.3)} for l in legs]}


def chain(short_ask, long_bid=.1, size=10):
    return {(l['strike'], l['right']): q(long_bid, long_bid+.1, size) if l['qty'] > 0
            else q(short_ask-.1, short_ask, size) for l in trade()['legs']}


class OptimizeTests(unittest.TestCase):
    def setUp(self):
        self.plan, _ = inputs()

    def test_expiry_and_round_trip_risk_reserve(self):
        t = trade(117)
        m = entry_metrics(t, self.plan)
        self.assertAlmostEqual(m['max_profit'], 194)
        self.assertAlmostEqual(m['expiry_risk'], 306)
        self.assertAlmostEqual(m['budget_risk'], 312)
        self.assertEqual(simulate_exit(t, {}, self.plan, 'expiry')['net_pnl_per_group_usd'], -306)

    def test_take_profit_executes_at_later_quote_not_trigger_target(self):
        path = {'10:01:00': chain(.4), '10:02:00': chain(.7)}
        result = simulate_exit(trade(), path, self.plan, 'tp50')
        self.assertEqual(result['trigger_time_et'], '10:01:00')
        self.assertAlmostEqual(result['trigger_pnl_usd'], 128)
        self.assertEqual(result['exit_time_et'], '10:02:00')
        self.assertAlmostEqual(result['net_pnl_per_group_usd'], 68)

    def test_stop_can_overshoot_and_missing_minute_is_not_backfilled(self):
        path = {'10:01:00': chain(1.5), '10:03:00': chain(2.2)}
        result = simulate_exit(trade(), path, self.plan, 'tp50_sl25')
        self.assertEqual(result['exit_reason'], 'stop_loss')
        self.assertEqual(result['trigger_time_et'], '10:01:00')
        self.assertEqual(result['exit_time_et'], '10:03:00')
        self.assertAlmostEqual(result['net_pnl_per_group_usd'], -232)
        self.assertEqual(result['missing_quote_minutes'], 1)

    def test_zero_bid_wings_remain_owned_and_settle(self):
        path = {'10:01:00': chain(.4,0), '10:02:00': chain(.4,0)}
        result = simulate_exit(trade(117), path, self.plan, 'tp50')
        self.assertEqual(result['close_fee_usd'], 3)
        self.assertEqual(len(result['residual_legs']), 2)
        self.assertEqual(result['residual_settlement_usd'], 200)
        self.assertEqual(result['net_pnl_per_group_usd'], 311)

    def test_quote_depth_applies_to_entire_order_and_risk_rounds_down(self):
        t = trade()
        m = entry_metrics(t, self.plan)
        self.assertEqual(position_size(20000,.01,m), 0)
        self.assertEqual(position_size(100000,.01,m), 3)
        self.assertIsNone(close_quote(t, chain(.4,size=2),3,1.5,0))
        self.assertIsNone(close_quote(t, chain(3),1,1.5,0))

    def test_pending_exit_falls_back_to_expiry_when_never_executable(self):
        result = simulate_exit(trade(117), {'10:01:00': chain(1.5)}, self.plan, 'tp50_sl25')
        self.assertTrue(result['pending_exit_unfilled'])
        self.assertEqual(result['exit_reason'], 'expiry')
        self.assertEqual(result['net_pnl_per_group_usd'], -306)

    def test_marks_include_retained_wing_and_do_not_clip_wide_quote(self):
        t = trade(117)
        path = {'10:00:00':chain(3), '10:01:00':chain(.4,0), '10:02:00':chain(.4,0)}
        result = simulate_exit(t, path, self.plan, 'tp50')
        marks = {p['time_et']:p['pnl_per_group_usd'] for p in liquidation_marks(t,path,result,self.plan,1,0)}
        self.assertAlmostEqual(marks['10:00:00'], -392)
        self.assertAlmostEqual(marks['10:02:00'], 111)
        self.assertAlmostEqual(marks['16:00:00'], 311)


if __name__ == '__main__':
    unittest.main()
