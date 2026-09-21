"""Registered PDE-E02 inputs: resumable exact-10:00 history, existing subscription."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from functools import partial
import hashlib
import json
from pathlib import Path
import threading

import polars as pl

from forecast import daily_data, write_json
from method_lock import ROOT, verify_method
from provider import client, safe_error
from replay import index_rows

PLAN = ROOT/'research/options/pde-e02.json'
OUT = ROOT/'data/thetadata/pde-e02'
_local = threading.local()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def register():
    verify_method()
    cfg = json.loads(PLAN.read_text())
    path = OUT/'registered-plan.json'
    if path.exists():
        registration = json.loads(path.read_text())
        if registration['plan_sha256'] != sha(PLAN):
            raise ValueError('PDE-E02 parameters changed; use a new experiment version')
        if registration['candidate_plan_sha256'] != sha(ROOT/cfg['economic_probe']['candidate_plan']):
            raise ValueError('Candidate experiment changed')
    else:
        days = [r for r in daily_data()['rows'] if cfg['start_date'] <= r['date'] <= cfg['end_date']]
        if not days or days[0]['date']!=cfg['start_date'] or days[-1]['date']!=cfg['end_date']:
            raise ValueError('Daily cache must cover the declared period')
        source = ROOT/'data/thetadata/self-forecast-v1/spx-daily.json'
        daily = OUT/'daily-input.json'
        daily.parent.mkdir(parents=True,exist_ok=True)
        daily.write_bytes(source.read_bytes())
        registration = {'registered_at':datetime.now(timezone.utc).isoformat(), 'plan':cfg,
                        'plan_sha256':sha(PLAN), 'candidate_plan_sha256':sha(ROOT/cfg['economic_probe']['candidate_plan']),
                        'daily_sha256':sha(daily), 'dates':[r['date'] for r in days],
                        'note':'Registered before E02 evaluation; previously inspected E01 history is not a fresh holdout.'}
        write_json(path,registration)
    if registration['daily_sha256'] != sha(OUT/'daily-input.json'):
        raise ValueError('Registered daily close input changed')
    return cfg,registration


def quote_path(day):
    folder = ROOT/'data/thetadata'/day
    for name in ('entry-snapshots-1000-1030-1100.parquet','forecast-snapshot-1000.parquet'):
        if (folder/name).exists():
            return folder/name
    return folder/'forecast-snapshot-1000.parquet'


def read_chain(day):
    path = quote_path(day)
    chains = index_rows(pl.read_parquet(path).to_dicts(),day)
    if '10:00:00' not in chains:
        raise ValueError('Exact 10:00:00 snapshot unavailable')
    return chains['10:00:00'], {'path':str(path),'sha256':sha(path)}


def fetch_day(day, authorized=None):
    path = quote_path(day)
    cached = path.exists()
    if not cached:
        if authorized is None:
            raise ValueError('Missing authorized download session')
        if not hasattr(_local,'theta'):
            from thetadata import ThetaClient
            _local.theta = ThetaClient(existing_authorized_client=authorized)
            # The SDK otherwise omits an RPC deadline; bound every historical call.
            stub = _local.theta.stub
            stub.GetOptionHistoryQuote = partial(stub.GetOptionHistoryQuote,timeout=60)
        day_date = date.fromisoformat(day)
        frame = _local.theta.option_history_quote(symbol='SPXW',expiration=day_date,date=day_date,
                strike='*',right='both',interval='1m',start_time='10:00:00',end_time='10:00:00')
        chains = index_rows(frame.to_dicts(),day)
        if set(chains) != {'10:00:00'}:
            raise ValueError('Downloaded snapshot has missing or unexpected timestamps')
        path.parent.mkdir(parents=True,exist_ok=True)
        tmp = path.with_suffix('.tmp')
        frame.sort(['timestamp','strike','right']).write_parquet(tmp)
        tmp.replace(path)
    chain,source = read_chain(day)
    return {'date':day,'cached':cached,'contracts':len(chain),**source}


def download(probe=False):
    cfg,registration = register()
    days = registration['dates']
    if probe:
        wanted = {'2025-09-16','2026-03-16','2026-07-22'}
        days = [d for d in days if d in wanted]
    status_path = OUT/'download-status.json'
    status = json.loads(status_path.read_text()) if status_path.exists() else {'completed':{},'errors':{}}
    missing = [d for d in days if not quote_path(d).exists()]
    authorized = client() if missing else None
    if authorized is not None and authorized.options_subscription == 0:
        raise PermissionError('Historical option quotes need the existing paid access')
    print(json.dumps({'requested_sessions':len(days),'cached':len(days)-len(missing),'downloads':len(missing),'workers':2}),flush=True)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {executor.submit(fetch_day,day,authorized):day for day in days}
        for i,future in enumerate(as_completed(futures),1):
            day = futures[future]
            try:
                status['completed'][day] = future.result()
                status['errors'].pop(day,None)
                print(f'[{i}/{len(days)}] {day}: {status["completed"][day]["contracts"]} contracts',flush=True)
            except Exception as exc:
                status['completed'].pop(day,None)
                status['errors'][day] = safe_error(exc)
                print(f'[{i}/{len(days)}] {day}: {safe_error(exc)}',flush=True)
            status['updated_at'] = datetime.now(timezone.utc).isoformat()
            write_json(status_path,status)
    failures = [d for d in days if d in status['errors']]
    print(json.dumps({'requested':len(days),'complete':len(days)-len(failures),'failed':failures}),flush=True)
    if failures:
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe',action='store_true')
    args = parser.parse_args()
    try:
        download(args.probe)
    except Exception as exc:
        raise SystemExit(safe_error(exc))
