"""Independent Decimal cashflow and accounting checks for optimization artifacts."""
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import polars as pl

from intraday import OUT, PLAN, write_json

D = lambda x: Decimal(str(x))


def equal(a, b):
    if abs(D(a)-D(b)) > D('.00001'):
        raise AssertionError((a, b))


def payoff(leg, spot):
    difference = D(spot)-D(leg['strike'])
    return D(leg['qty'])*max(D(0), difference if leg['right'] == 'call' else -difference)*100


def key(row):
    return tuple(row[k] for k in ('band','width','filter','exit','extra_slippage_points','initial_equity','risk_fraction'))


def main():
    data = json.loads((OUT/'results.json').read_text())
    marks = json.loads((OUT/'minute-marks.json').read_text())
    status = json.loads((OUT/'download-status.json').read_text())
    assert not status['errors']
    assert len(status['completed']) == status['expected_contracts']
    raw_quotes = {}
    for item in status['completed'].values():
        assert hashlib.sha256(Path(item['path']).read_bytes()).hexdigest() == item['sha256']
        assert item['rows'] == 360 and item['missing_minutes'] == 0
        for q in pl.read_parquet(item['path']).to_dicts():
            raw_quotes[(item['date'], item['strike'], item['right'], q['timestamp'].strftime('%H:%M:%S'))] = q
    assert hashlib.sha256(PLAN.read_bytes()).hexdigest() == data['registered_plan']['plan_sha256']
    fee = D(data['registered_plan']['plan']['fee_per_contract'])
    grouped = defaultdict(list)
    checked = 0
    for row in data['trades']:
        grouped[key(row)].append(row)
        if row['status'] != 'traded':
            equal(row['pnl_usd'], 0)
            assert row['groups'] == 0
            continue
        checked += 1
        slip = D(row['extra_slippage_points'])
        debit = sum(D(q['qty']) * (D(q['ask'])+slip if q['qty'] > 0 else D(q['bid'])-slip)*100
                    for q in row['entry_quotes'])
        equal(-debit, row['entry_credit_usd'])
        open_fee = fee * sum(abs(q['qty']) for q in row['entry_quotes'])
        equal(open_fee, row['open_fee_usd'])
        for q in row['entry_quotes']:
            assert q['ask_size' if q['qty'] > 0 else 'bid_size'] >= abs(q['qty'])*row['groups']
            original = raw_quotes[(row['date'],q['strike'],q['right'],'10:00:00')]
            for field in ('bid','ask','bid_size','ask_size'):
                equal(q[field],original[field])
        net = -debit-open_fee
        if row['exit_reason'] == 'expiry':
            net += sum(payoff(l,row['settlement_price']) for l in row['legs'])
            assert not row['closed_quotes']
        else:
            close_cash = D(0)
            for q in row['closed_quotes']:
                original = raw_quotes[(row['date'],q['strike'],q['right'],row['exit_time_et'])]
                for field in ('bid','ask','bid_size','ask_size'):
                    equal(q[field],original[field])
                expected = D(q['bid'])-slip if q['qty'] > 0 else D(q['ask'])+slip
                equal(q['price'], expected)
                assert q['bid_size' if q['qty'] > 0 else 'ask_size'] >= abs(q['qty'])*row['groups']
                close_cash += D(q['qty'])*D(q['price'])*100
            close_fee = fee*sum(abs(q['qty']) for q in row['closed_quotes'])
            equal(close_cash, row['close_cash_usd'])
            equal(close_fee, row['close_fee_usd'])
            residual = sum(payoff(l,row['settlement_price']) for l in row['residual_legs'])
            equal(residual, row['residual_settlement_usd'])
            assert all(l['qty'] > 0 for l in row['residual_legs'])
            for leg in row['residual_legs']:
                original = raw_quotes[(row['date'],leg['strike'],leg['right'],row['exit_time_et'])]
                assert D(original['bid']) <= slip
            assert len(row['closed_quotes'])+len(row['residual_legs']) == len(row['legs'])
            net += close_cash-close_fee+residual
            trigger = datetime.fromisoformat(row['date']+'T'+row['trigger_time_et'])
            fill = datetime.fromisoformat(row['date']+'T'+row['exit_time_et'])
            assert (fill-trigger).total_seconds() >= 60
            assert row['exit_time_et'] <= '15:59:00'
        equal(net, row['net_pnl_per_group_usd'])
        equal(net*row['groups'], row['pnl_usd'])
        risk = D(row['width'])*100+debit+fee*8
        equal(risk, row['risk_per_group_usd'])
        equal(risk*row['groups'], row['risk_allocated_usd'])
        assert net >= -risk-D('.00001')
        if row['initial_equity']:
            assert risk*row['groups'] <= D(row['equity_before_usd'])*D(row['risk_fraction'])+D('.00001')
        equal(marks[row['path_id']][-1]['pnl_per_group_usd'], net)
        assert len(marks[row['path_id']]) <= 361
    for summary in data['summaries']:
        rows = grouped[key(summary)]
        assert len(rows) == 38
        assert len({r['date'] for r in rows}) == 38
        equal(sum(D(r['pnl_usd']) for r in rows), summary['net_pnl_usd'])
        assert summary['trades'] == sum(r['status']=='traded' for r in rows)
        assert summary['wins'] == sum(r['pnl_usd'] > 1e-8 for r in rows)
        assert summary['losses'] == sum(r['pnl_usd'] < -1e-8 for r in rows)
        equity = D(summary['initial_equity'] or 0)
        daily_peak = minute_peak = equity
        daily_dd = minute_dd = D(0)
        for row, point in zip(rows, summary['curve']):
            if summary['initial_equity']:
                equal(row['equity_before_usd'], equity)
            if row['status']=='traded':
                for mark in marks[row['path_id']]:
                    value = equity+D(mark['pnl_per_group_usd'])*row['groups']
                    minute_peak = max(minute_peak,value)
                    minute_dd = max(minute_dd,minute_peak-value)
            equity += D(row['pnl_usd'])
            daily_peak = max(daily_peak,equity)
            daily_dd = max(daily_dd,daily_peak-equity)
            equal(point['cumulative_pnl_usd'], equity-D(summary['initial_equity'] or 0))
        equal(daily_dd,summary['daily_max_drawdown_usd'])
        equal(minute_dd,summary['sampled_liquidation_max_drawdown_usd'])
    previous = json.loads((OUT.parent/'balder-multiday/results.json').read_text())
    matched = 0
    for s in data['summaries']:
        if s['initial_equity'] is not None or s['extra_slippage_points'] != 0 or s['exit'] != 'expiry' or s['filter']=='price_quality':
            continue
        old = next(x for x in previous['summaries'] if x['strategy']=='condor' and x['entry_time_et']=='10:00'
                   and x['pricing']=='natural' and x['band']==s['band'] and x['width_mode']==str(s['width'])
                   and x['filter_both_condor_sides']==(s['filter']=='both_sides'))
        equal(s['net_pnl_usd'],old['net_pnl_usd'])
        equal(s['daily_max_drawdown_usd'],old['daily_equity_max_drawdown_usd'])
        assert s['trades']==old['trades']
        matched += 1
    audit = {'verified_at':datetime.now(timezone.utc).isoformat(), 'sessions':38,
             'source_contract_hashes':len(status['completed']), 'minute_rows':sum(x['rows'] for x in status['completed'].values()),
             'entry_quote_crosschecks':data['entry_quote_crosschecks'], 'decimal_trade_checks':checked,
             'series_accounting_checks':len(data['summaries']), 'baseline_matches':matched,
             'distinct_minute_paths':len(marks), 'original_forecast_publication_verified':False,
             'results_sha256':hashlib.sha256((OUT/'results.json').read_bytes()).hexdigest(),
             'minute_marks_sha256':hashlib.sha256((OUT/'minute-marks.json').read_bytes()).hexdigest()}
    write_json(OUT/'audit.json',audit)
    print(json.dumps(audit,indent=2))


if __name__=='__main__':
    main()
