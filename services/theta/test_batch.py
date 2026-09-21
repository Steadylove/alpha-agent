"""Hand-computed butterfly payoffs and multi-session capital-path checks."""
import unittest

from batch import butterfly_legs, price_trade, summarize


class BatchTests(unittest.TestCase):
    def test_band_width_covers_both_endpoints(self):
        legs, width = butterfly_legs(7595, 7691, 'band')
        self.assertEqual(width, 50)
        self.assertEqual([x['strike'] for x in legs], [7595, 7645, 7695])
        self.assertEqual([x['qty'] for x in legs], [1, -2, 1])

    def test_butterfly_cashflows_and_two_contract_short_size(self):
        chain = {
            (90,'call'):{'bid':12,'ask':12.2,'bid_size':5,'ask_size':5},
            (100,'call'):{'bid':5,'ask':5.2,'bid_size':5,'ask_size':5},
            (110,'call'):{'bid':1,'ask':1.2,'bid_size':5,'ask_size':5}}
        for close,expected in [(80,-346),(90,-346),(95,154),(100,654),(105,154),(110,-346),(120,-346)]:
            record={'date':'2026-09-14','bands':{'68':[90,110]},'settlement_price':close}
            result=price_trade(record,'butterfly','68',10,'10:00','natural',chain)
            self.assertEqual(result['status'],'priced')
            self.assertAlmostEqual(result['net_pnl_usd'],expected)
            self.assertAlmostEqual(result['max_loss_usd'],346)
            self.assertAlmostEqual(result['max_profit_usd'],654)
        chain[(100,'call')]['bid_size']=1
        self.assertEqual(price_trade(record,'butterfly','68',10,'10:00','natural',chain)['status'],'skipped')

    def test_daily_drawdown_uses_path_and_skips_are_not_wins(self):
        rows=[]
        for i,value in enumerate([100,-50,None,-100,30]):
            rows.append({'date':f'2026-09-{i+1:02d}','strategy':'condor','band':'95','width_mode':'10',
                         'entry_time_et':'10:00','pricing':'natural',
                         'status':'skipped' if value is None else 'priced','net_pnl_usd':value,
                         'max_loss_usd':951,'capital_reference_usd':1006})
        s=summarize(rows)
        self.assertEqual(s['net_pnl_usd'],-20)
        self.assertEqual(s['daily_equity_max_drawdown_usd'],150)
        self.assertEqual(s['trades'],4)
        self.assertEqual(s['skips'],1)
        self.assertEqual(s['win_rate'],.5)
        self.assertEqual(s['max_consecutive_losing_trades'],2)
        self.assertEqual(s['starting_capital_path_estimate_usd'],1056)


if __name__=='__main__':
    unittest.main()
