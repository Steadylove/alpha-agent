"""Independent cashflow and Gaussian-quadrature audit of PDE-E01 artifacts.

Does not import density.py or pde.py: checks their closed-form answers with direct
leg cashflows, stdlib NormalDist, and numerical integration in normal space.
"""
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
from statistics import NormalDist

from scipy.integrate import quad

from method_lock import ROOT, verify_method
from replay import settlement_pnl

OUT = ROOT / 'data/thetadata/pde-e01'
N = NormalDist()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def audit():
    path = OUT / 'results.json'
    result = json.loads(path.read_text())
    cfg = result['experiment']
    assert cfg['discount_factor'] == 1
    hashes = result['input_hashes']
    sources = {'plan': ROOT/'research/options/pde-e01.json',
               'code': ROOT/'services/theta/pde.py', 'density_code': ROOT/'services/theta/density.py',
               'forecast_adapter_code': ROOT/'services/theta/forecast.py',
               'replay_code': ROOT/'services/theta/replay.py',
               'evaluation': ROOT/'data/thetadata/self-forecast-v1/evaluation.json',
               'daily': ROOT/'data/thetadata/self-forecast-v1/spx-daily.json'}
    for key, file in sources.items():
        assert hashes[key] == sha(file), f'Input changed: {key}'
    for day, expected in hashes['quotes'].items():
        assert expected == sha(ROOT/'data/thetadata'/day/'entry-snapshots-1000-1030-1100.parquet')
    assert hashes['method'] == verify_method()['method_file_sha256']
    assert json.loads((OUT/'registered-plan.json').read_text())['plan_sha256'] == hashes['plan']
    assert json.loads(sources['plan'].read_text()) == cfg
    closes = {r['date']:r['close'] for r in json.loads(sources['daily'].read_text())['rows']}
    distributions = {d['date']:d for d in result['distributions']}
    errors = {'ev_usd':0., 'expected_loss_usd':0., 'tail_mean_usd':0., 'profit_probability':0.,
              'loss_probability':0., 'expiry_cashflow_usd':0.}
    failures, checked = [], 0
    for row in result['records']:
        assert row['decision'] == 'NO_TRADE_RESEARCH_ONLY'
        if row['status'] != 'priced':
            if row['status'] == 'baseline':
                assert row['net_pnl_usd'] == 0
            continue
        try:
            checked += 1
            legs, m = row['legs'], row['metrics']
            d = distributions[row['date']]
            vol, forward = d['total_vol'], d['forward']
            mu = math.log(forward)-vol**2/2
            count = sum(abs(l['qty']) for l in legs)
            natural = sum(l['qty']*l['ask' if l['qty']>0 else 'bid'] for l in row['entry_quotes'])
            mid = sum(l['qty']*(l['ask']+l['bid'])/2 for l in row['entry_quotes'])
            assert abs(natural-row['entry_debit_points']) < 1e-10
            assert abs(mid-row['mid_debit_points']) < 1e-10
            assert abs(m['opening_fees_usd']-count*cfg['fee_per_contract_usd']) < 1e-10
            assert abs(m['extra_slippage_usd']-count*100*cfg['extra_slippage_per_contract_points']) < 1e-10
            for l in row['entry_quotes']:
                assert 0 <= l['bid'] <= l['ask']
                assert l['ask' if l['qty']>0 else 'bid'] > 0
                assert l['ask_size' if l['qty']>0 else 'bid_size'] >= abs(l['qty'])
            cost = natural*100 + count*(cfg['fee_per_contract_usd']+100*cfg['extra_slippage_per_contract_points'])

            def cash(spot):
                total = 0.
                for l in legs:
                    intrinsic = max(spot-l['strike'],0.) if l['right']=='call' else max(l['strike']-spot,0.)
                    total += l['qty']*intrinsic*100
                return total-cost

            # Reconstruct straight segments from endpoint cashflows, independently
            # of density.py's symbolic leg-slope calculation.
            strikes = sorted({float(l['strike']) for l in legs})
            endpoints = [0.]+strikes
            lines = []
            for a,b in zip(endpoints,endpoints[1:]):
                slope = round((cash(b)-cash(a))/(b-a), 8)
                lines.append((a,b,slope,cash(a)-slope*a))
            assert abs(cash(strikes[-1])-cash(2*strikes[-1])) < 1e-7
            lines.append((strikes[-1], math.inf, 0., cash(strikes[-1])))
            lows = [cash(s) for s in endpoints]
            assert abs(min(lows)-m['net_pnl_min_usd']) < 1e-7
            assert abs(max(lows)-m['net_pnl_max_usd']) < 1e-7

            def cdf(spot):
                return N.cdf((math.log(spot)-mu)/vol) if spot>0 else 0.

            def probability_below(level, strict=False):
                mass = 0.
                for low,high,slope,intercept in lines:
                    if slope == 0:
                        if (intercept < level if strict else intercept <= level):
                            mass += cdf(high)-cdf(low)
                    else:
                        root = (level-intercept)/slope
                        lo,hi = ((low,max(low,min(high,root))) if slope>0 else (min(high,max(low,root)),high))
                        mass += cdf(hi)-cdf(lo)
                return mass

            q = m['lower_pnl_quantile_usd']
            alpha = cfg['tail_probability']
            assert probability_below(q+1e-6) >= alpha-1e-9
            assert probability_below(q-1e-6) <= alpha+1e-9
            # Kink-aware quadrature, including zero and tail-quantile crossings.
            spots = set(strikes)
            for low,high,slope,intercept in lines:
                for level in (0.,q):
                    if slope:
                        root = (level-intercept)/slope
                        if low < root < high:
                            spots.add(root)
            cuts = [-12.] + sorted((math.log(s)-mu)/vol for s in spots if s>0 and -12 < (math.log(s)-mu)/vol < 12) + [12.]

            def integrate(transform):
                def f(z):
                    return transform(cash(math.exp(mu+vol*z)))*N.pdf(z)
                return sum(quad(f,a,b,epsabs=2e-8,epsrel=1e-10)[0] for a,b in zip(cuts,cuts[1:]))

            checks = {'ev_usd': (integrate(lambda y:y), m['model_ev_net_usd']),
                      'expected_loss_usd': (integrate(lambda y:max(-y,0)), m['expected_loss_usd']),
                      'tail_mean_usd': (q-integrate(lambda y:max(q-y,0))/alpha, m['worst_tail_mean_pnl_usd']),
                      'profit_probability': (1-probability_below(0), m['p_profit']),
                      'loss_probability': (probability_below(0,strict=True), m['p_loss']),
                      'expiry_cashflow_usd': (settlement_pnl(legs,natural,closes[row['date']],cfg['fee_per_contract_usd'])-m['extra_slippage_usd'],row['observed_expiry_pnl_usd'])}
            for key,(actual,expected) in checks.items():
                errors[key] = max(errors[key],abs(actual-expected))
                assert abs(actual-expected) < (1e-9 if key.endswith('probability') else 2e-5), (key,actual,expected)
            assert abs(m['p_profit']+m['p_loss']+m['p_breakeven']-1) < 1e-10
            assert m['max_loss_net_usd']+1e-6 >= m['expected_shortfall_loss_usd'] >= 0
            assert abs(m['expected_gain_usd']-m['expected_loss_usd']-m['model_ev_net_usd']) < 1e-7
        except AssertionError as exc:
            failures.append({'date':row['date'], 'candidate':row['candidate'], 'failure':str(exc)})
    assert checked == result['totals']['priced_candidates']
    assert len(result['records']) == len(hashes['quotes'])*(len(cfg['candidates'])+1)
    assert len({(r['date'],r['candidate']) for r in result['records']}) == len(result['records'])
    for summary in result['summaries']:
        rows = [r for r in result['records'] if r['candidate']==summary['candidate'] and r['status']=='priced']
        assert summary['priced'] == len(rows)
        assert summary['skipped'] == len(hashes['quotes'])-len(rows)
        if rows:
            assert summary['observed_wins'] == sum(r['observed_expiry_pnl_usd']>0 for r in rows)
            assert summary['observed_losses'] == sum(r['observed_expiry_pnl_usd']<0 for r in rows)
            assert abs(summary['observed_expiry_pnl_sum_usd']-sum(r['observed_expiry_pnl_usd'] for r in rows)) < 1e-8
    payload = {'created_at':datetime.now(timezone.utc).isoformat(), 'result_sha256':sha(path),
               'audit_code_sha256':sha(Path(__file__)), 'all_passed':not failures, 'checked_candidates':checked,
               'maximum_absolute_errors':errors, 'failures':failures,
               'quadrature': 'Gaussian z in [-12,12]; omitted mass < 4e-33, all audited payoffs bounded. Independent of analytic integration.',
               'scope': 'Checks cached source hashes, frozen method, quote cashflows, bounded risk, Q0 probability/EV/ES and expiry cashflow. Not an execution or profitability validation.'}
    (OUT/'audit.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(payload,ensure_ascii=False,indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    audit()
