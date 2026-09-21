import unittest

from short_put_replay import drawdown, payoff, wilson


class ShortPutTests(unittest.TestCase):
    def test_piecewise_cash_payoff(self):
        self.assertAlmostEqual(payoff(7500, 1, 7520, 3.5), 96.5)
        self.assertAlmostEqual(payoff(7500, 1, 7500, 3.5), 96.5)
        self.assertAlmostEqual(payoff(7500, 1, 7499.035, 3.5), 0, places=7)
        self.assertAlmostEqual(payoff(7500, 1, 7400, 3.5), -9903.5)
        self.assertAlmostEqual(payoff(7500, 1, 0, 3.5), -749903.5)

    def test_drawdown_from_cash_peak_not_worst_day(self):
        self.assertEqual(drawdown([-20, 100, 60, 30, 110]), 70)
        self.assertEqual(drawdown([10, 20, 30]), 0)

    def test_all_wins_do_not_establish_certain_future_success(self):
        low, high = wilson(39,39)
        self.assertTrue(.90 < low < .92)
        self.assertAlmostEqual(high, 1)


if __name__ == '__main__': unittest.main()
