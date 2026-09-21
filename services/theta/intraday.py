"""Resume one-minute histories for only the contracts selected before entry."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import threading

import polars as pl

from batch import LEDGER, price_trade, validate_snapshot
from provider import ROOT, client, safe_error
from replay import index_rows

PLAN = ROOT / 'research/options/balder-optimization-v1.json'
OUT = ROOT / 'data/thetadata/balder-optimization-v1'
_local = threading.local()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
    tmp.replace(path)


def inputs():
    return json.loads(PLAN.read_text()), json.loads(LEDGER.read_text())


def candidates(plan, ledger):
    """Uses forecast bounds and exact entry quotes only; never filters on outcomes."""
    rows = []
    for record in ledger['sessions']:
        path = ROOT / 'data/thetadata' / record['date'] / 'entry-snapshots-1000-1030-1100.parquet'
        chain = validate_snapshot(pl.read_parquet(path), record['date'])[plan['entry_time_et']]
        for band in plan['bands']:
            for width in plan['wing_widths']:
                rows.append(price_trade(record, 'condor', band, width, '10:00', 'natural', chain))
    return rows


def contract_path(day, strike, right):
    return ROOT / 'data/thetadata' / day / f'intraday-{strike:g}-{right}.parquet'


def validate_contract(frame, day, strike, right):
    chains = index_rows(frame.to_dicts(), day)
    if not chains or any(set(chain) != {(float(strike), right)} for chain in chains.values()):
        raise ValueError(f'{day} {strike} {right}: unexpected contract')
    if any(not '10:00:00' <= stamp <= '15:59:00' or stamp[-2:] != '00' for stamp in chains):
        raise ValueError('Unexpected timestamp in 1m path')
    # Missing minutes are retained and counted, never manufactured or silently backfilled.
    if '10:00:00' not in chains:
        raise ValueError(f'{day} {strike} {right}: missing entry quote')
    return chains


def fetch_contract(spec, authorized):
    day, strike, right = spec
    path = contract_path(*spec)
    source = 'ThetaData single-contract 1m NBBO'
    if path.exists():
        frame = pl.read_parquet(path)
        source = 'existing single-contract 1m cache'
    elif (path.parent / 'quotes.parquet').exists():
        frame = pl.read_parquet(path.parent / 'quotes.parquet').filter(
            (pl.col('strike') == strike) &
            pl.col('right').str.to_lowercase().is_in([right, right[0]]) &
            (pl.col('timestamp').dt.strftime('%H:%M:%S') >= '10:00:00') &
            (pl.col('timestamp').dt.strftime('%H:%M:%S') <= '15:59:00'))
        source = 'existing full-day 1m cache'
    else:
        if not hasattr(_local, 'theta'):
            from thetadata import ThetaClient
            _local.theta = ThetaClient(existing_authorized_client=authorized)
        d = date.fromisoformat(day)
        frame = _local.theta.option_history_quote(
            symbol='SPXW', expiration=d, date=d, strike=f'{strike:g}', right=right,
            interval='1m', start_time='10:00:00', end_time='15:59:00')
    validate_contract(frame, *spec)
    frame = frame.sort('timestamp')
    tmp = path.with_suffix('.tmp')
    frame.write_parquet(tmp)
    tmp.replace(path)
    return {'date': day, 'strike': strike, 'right': right, 'rows': frame.height,
            'missing_minutes': 360 - frame.height, 'source': source,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'path': str(path)}


def download():
    plan, ledger = inputs()
    OUT.mkdir(parents=True, exist_ok=True)
    registration = OUT / 'registered-plan.json'
    if not registration.exists():
        write_json(registration, {'registered_at': datetime.now(timezone.utc).isoformat(),
            'plan_sha256': hashlib.sha256(PLAN.read_bytes()).hexdigest(), 'plan': plan,
            'note': 'Registered before new intraday exit results, but after inspection of earlier expiry results.'})
    elif json.loads(registration.read_text())['plan_sha256'] != hashlib.sha256(PLAN.read_bytes()).hexdigest():
        raise ValueError('Research plan changed after registration; create a new version instead')
    specs = sorted({(r['date'], leg['strike'], leg['right'])
                    for r in candidates(plan, ledger) if r['status'] == 'priced' for leg in r['legs']})
    authorized = client()
    if not authorized.options_subscription:
        raise PermissionError('Paid options access required')
    completed, errors = {}, {}
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {executor.submit(fetch_contract, spec, authorized): spec for spec in specs}
        for future in as_completed(futures):
            spec = futures[future]
            key = '|'.join(map(str, spec))
            try:
                completed[key] = future.result()
            except Exception as exc:
                errors[key] = safe_error(exc)
            n = len(completed) + len(errors)
            if n % 10 == 0 or n == len(specs) or key in errors:
                print(f'[{n}/{len(specs)}] contracts; errors={len(errors)}; latest={key}', flush=True)
            write_json(OUT/'download-status.json', {'completed': completed, 'errors': errors,
                'expected_contracts': len(specs), 'updated_at': datetime.now(timezone.utc).isoformat()})
    if errors:
        raise RuntimeError(f'{len(errors)} contracts missing; cache retained; rerun download')
    print(f"Complete: {len(completed)} contracts, {sum(x['rows'] for x in completed.values()):,} minute rows", flush=True)


def load_chains(day, legs):
    frames = []
    for leg in legs:
        spec = day, leg['strike'], leg['right']
        frame = pl.read_parquet(contract_path(*spec))
        validate_contract(frame, *spec)
        frames.append(frame)
    return index_rows(pl.concat(frames, how='vertical_relaxed').to_dicts(), day)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    download()
