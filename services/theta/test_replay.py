"""Hand-calculated payoff and missing-data regression cases, not market results."""
import unittest

from replay import legs_for_band, open_cost, quote_valid, run_scenarios, settlement_pnl


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.legs = legs_for_band(100, 120, 10)
        self.chain = {
            (90, "put"): {"bid": .2, "ask": .3, "bid_size": 10, "ask_size": 10},
            (100, "put"): {"bid": 1.5, "ask": 1.7, "bid_size": 10, "ask_size": 10},
            (120, "call"): {"bid": 1.5, "ask": 1.7, "bid_size": 10, "ask_size": 10},
            (130, "call"): {"bid": .2, "ask": .3, "bid_size": 10, "ask_size": 10},
        }

    def test_outward_rounding(self):
        legs = legs_for_band(7538, 7700, 10)
        self.assertEqual([v["strike"] for v in legs], [7525, 7535, 7700, 7710])

    def test_natural_credit_and_mid_are_distinct(self):
        self.assertAlmostEqual(open_cost(self.legs, self.chain, "natural"), -2.4)
        self.assertAlmostEqual(open_cost(self.legs, self.chain, "mid"), -2.7)

    def test_center_and_both_tail_losses(self):
        for spot, expected in [(110, 234), (100, 234), (120, 234), (95, -266),
                               (125, -266), (85, -766), (135, -766)]:
            with self.subTest(spot=spot):
                self.assertAlmostEqual(settlement_pnl(self.legs, -2.4, spot, 1.5), expected)

    def test_gross_breakeven_still_pays_fees(self):
        self.assertAlmostEqual(settlement_pnl(self.legs, -2.4, 97.6, 1.5), -6)

    def test_missing_or_unexecutable_quotes_cannot_be_filled(self):
        for mutation in ({"bid_size": 0}, {"bid": 0}, {"bid": 2, "ask": 1}, {"ask": float("nan")}):
            chain = {k: dict(v) for k, v in self.chain.items()}
            chain[(100, "put")].update(mutation)
            self.assertIsNone(open_cost(self.legs, chain, "natural"))
        self.assertFalse(quote_valid(None, "bid"))

    def test_no_future_quote_fill_and_max_loss(self):
        config = {"date": "2026-09-15", "bands": {"68": [100, 120]}, "wing_widths": [10],
                  "strike_step": 5, "entry_times": ["10:00"], "settlement_price": 110,
                  "fee_per_contract": 1.5}
        rows = [{**q, "strike": strike, "right": right, "symbol": "SPXW",
                 "expiration": "2026-09-15", "timestamp": "2026-09-15T10:01:00"}
                for (strike, right), q in self.chain.items()]
        report = run_scenarios(config, rows)
        self.assertTrue(all(r["status"] == "skipped" for r in report["scenarios"]))
        for q in rows:
            q["timestamp"] = "2026-09-15T10:00:00"
        natural = run_scenarios(config, rows)["scenarios"][0]
        self.assertEqual(natural["status"], "priced")
        self.assertAlmostEqual(natural["net_settlement_pnl_usd"], 234)
        self.assertAlmostEqual(natural["max_loss_net_usd"], 766)
        rows[0]["expiration"] = "2026-09-16"
        with self.assertRaises(ValueError):
            run_scenarios(config, rows)


if __name__ == "__main__":
    unittest.main()
