"""E03 registered, cached, read-only option data collection."""
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from functools import partial
import json
import threading

import polars as pl

from method_lock import ROOT, verify_method
from pde_history import sha
from provider import client, safe_error, ET

PLAN = ROOT/'research/options/pde-e03.json'
OUT = ROOT/'data/thetadata/pde-e03'
_local = threading.local()


def register():
    verify_method()
    cfg=json.loads(PLAN.read_text())
    source=ROOT/'data/thetadata/pde-e02/daily-input.json'
    daily=json.loads(source.read_text())
    days=[r['date'] for r in daily['rows'] if cfg['input_start']<=r['date']<=cfg['last_settlement_date']]
    jobs=[{'date':d,'expiration':days[i+offset],'offset':offset}
          for i,d in enumerate(days) if d<=cfg['last_decision_date']
          for offset in cfg['expiry_session_offsets'] if i+offset<len(days)]
    OUT.mkdir(parents=True,exist_ok=True)
    path=OUT/'registered-plan.json'
    if path.exists():
        record=json.loads(path.read_text())
        if record['plan_sha256']!=sha(PLAN) or record['daily_sha256']!=sha(source):
            raise ValueError('E03 registered inputs changed; create a new experiment')
    else:
        record={'registered_at':datetime.now(timezone.utc).isoformat(),'plan_sha256':sha(PLAN),
                'daily_sha256':sha(source),'daily_source':str(source),'plan':cfg,'jobs':jobs,
                'sample_warning':cfg['evaluation']['sample_status']}
        path.write_text(json.dumps(record,indent=2)+'\n')
    return cfg,record


def path_for(job):
    return OUT/'quotes'/f"{job['date']}-expiry-{job['expiration']}.parquet"


def read_chains(job,cfg):
    frame=pl.read_parquet(path_for(job))
    result={}
    for row in frame.to_dicts():
        ts=row['timestamp'].astimezone(ET)
        if ts.date().isoformat()!=job['date'] or str(row['expiration'])!=job['expiration'] or row['symbol']!='SPXW':
            raise ValueError('Quote date, expiry or symbol mismatch')
        stamp=ts.strftime('%H:%M:%S')
        if stamp not in cfg['entry_times_et']:
            continue
        if ts.microsecond:
            raise ValueError('Interval snapshot must have exact timestamp')
        actual=row.get('quote_timestamp')
        if actual is not None and (actual.astimezone(ET).date()!=ts.date() or actual>row['timestamp']):
            raise ValueError('At-time quote is stale across sessions or from the future')
        row['right']=row['right'].lower()
        key=(float(row['strike']),row['right'])
        chain=result.setdefault(stamp,{})
        if key in chain:
            raise ValueError('Duplicate snapshot contract')
        chain[key]=row
    return result


def fetch(job,authorized,cfg):
    path=path_for(job)
    cached=path.exists()
    if not cached:
        from thetadata import ThetaClient
        if not hasattr(_local,'theta'):
            _local.theta=ThetaClient(existing_authorized_client=authorized)
            stub=_local.theta.stub
            stub.GetOptionHistoryQuote=partial(stub.GetOptionHistoryQuote,timeout=cfg['download']['rpc_timeout_seconds'])
        frame=_local.theta.option_history_quote(symbol='SPXW',date=date.fromisoformat(job['date']),
            expiration=date.fromisoformat(job['expiration']),strike='*',right='both',
            interval=cfg['download']['interval'],start_time=cfg['download']['start_time'],
            end_time=cfg['download']['end_time'])
        if frame.is_empty():
            raise ValueError('Empty historical chain')
        path.parent.mkdir(parents=True,exist_ok=True)
        frame.write_parquet(path.with_suffix('.tmp'))
        path.with_suffix('.tmp').replace(path)
    chains=read_chains(job,cfg)
    return {**job,'cached':cached,'times':{t:len(c) for t,c in chains.items()},'sha256':sha(path)}


def fetch_group(jobs,authorized,cfg):
    missing=[job for job in jobs if not path_for(job).exists()]
    if missing:
        from thetadata import ThetaClient
        if not hasattr(_local,'theta'):
            _local.theta=ThetaClient(existing_authorized_client=authorized)
            stub=_local.theta.stub
            stub.GetOptionHistoryQuote=partial(stub.GetOptionHistoryQuote,timeout=cfg['download']['rpc_timeout_seconds'])
        day=date.fromisoformat(jobs[0]['date'])
        max_dte=max((date.fromisoformat(j['expiration'])-day).days for j in jobs)
        # Exact snapshots avoid making the vendor scan a four-hour quote interval.
        from pde_search_math import CASH_EARLY_CLOSE
        parts=[]
        for stamp in cfg['entry_times_et']:
            if stamp>=CASH_EARLY_CLOSE.get(day.isoformat(),'16:00:00'):
                continue
            parts.append(_local.theta.option_history_quote(symbol='SPXW',date=day,expiration='*',max_dte=max_dte,
                strike='*',right='both',interval='1m',start_time=stamp,end_time=stamp))
        frame=pl.concat(parts,how='vertical_relaxed')
        for job in missing:
            subset=frame.filter(pl.col('expiration').cast(pl.String)==job['expiration'])
            if subset.is_empty():
                raise ValueError('Missing requested expiry in combined response: '+job['expiration'])
            path=path_for(job);path.parent.mkdir(parents=True,exist_ok=True)
            subset.write_parquet(path.with_suffix('.tmp'));path.with_suffix('.tmp').replace(path)
    return [fetch(job,authorized,cfg) for job in jobs]


def fetch_expiry_jobs(jobs,authorized,cfg):
    """Request the same expiration over its two needed decision sessions."""
    missing=[j for j in jobs if not path_for(j).exists()]
    if not missing:
        return [fetch(j,authorized,cfg) for j in jobs]
    from thetadata import ThetaClient
    if not hasattr(_local,'theta'):
        _local.theta=ThetaClient(existing_authorized_client=authorized)
        stub=_local.theta.stub
        stub.GetOptionAtTimeQuote=partial(stub.GetOptionAtTimeQuote,timeout=cfg['download']['rpc_timeout_seconds'])
    from pde_search_math import CASH_EARLY_CLOSE
    parts=[];expiry=jobs[0]['expiration'];days={j['date'] for j in missing}
    for stamp in cfg['entry_times_et']:
        cache=OUT/'asof-parts'/f'{min(days)}-{max(days)}-{expiry}-{stamp.replace(":","")}.parquet'
        if cache.exists():
            parts.append(pl.read_parquet(cache));continue
        required={d for d in days if stamp<CASH_EARLY_CLOSE.get(d,'16:00:00')}
        if not required:
            continue
        raw=_local.theta.option_at_time_quote(symbol='SPXW',expiration=date.fromisoformat(expiry),
            start_date=date.fromisoformat(min(required)),end_date=date.fromisoformat(max(required)),
            time_of_day=stamp,strike='*',right='both')
        rows=[]
        for row in raw.to_dicts():
            day=row['timestamp'].astimezone(ET).date().isoformat()
            if day not in required:
                continue
            snapshot=datetime.fromisoformat(day+'T'+stamp).replace(tzinfo=ET)
            if row['timestamp']>snapshot:
                raise ValueError('Future quote returned by as-of API')
            row['quote_timestamp']=row['timestamp'];row['timestamp']=snapshot
            rows.append(row)
        part=pl.DataFrame(rows)
        cache.parent.mkdir(parents=True,exist_ok=True)
        part.write_parquet(cache.with_suffix('.tmp'));cache.with_suffix('.tmp').replace(cache)
        parts.append(part)
    frame=pl.concat(parts,how='vertical_relaxed')
    for job in missing:
        subset=frame.filter(pl.col('timestamp').dt.date()==date.fromisoformat(job['date']))
        if subset.is_empty():
            raise ValueError('Missing registered date in expiration query: '+job['date'])
        path=path_for(job);path.parent.mkdir(parents=True,exist_ok=True)
        subset.write_parquet(path.with_suffix('.tmp'));path.with_suffix('.tmp').replace(path)
    return [fetch(j,authorized,cfg) for j in jobs]


def download_bulk():
    cfg,record=register();jobs=record['jobs']
    status_path=OUT/'download-status.json'
    status=json.loads(status_path.read_text()) if status_path.exists() else {'complete':{},'errors':{}}
    groups=defaultdict(list)
    for job in jobs:
        if not path_for(job).exists():
            groups[job['expiration']].append(job)
    authorized=client() if groups else None
    print(json.dumps({'missing_jobs':sum(map(len,groups.values())),'expiry_requests':len(groups)}),flush=True)
    failures=[]
    with ThreadPoolExecutor(max_workers=cfg['download']['workers']) as executor:
        futures={executor.submit(fetch_expiry_jobs,g,authorized,cfg):g for g in groups.values()}
        for n,future in enumerate(as_completed(futures),1):
            group=futures[future]
            try:
                for row in future.result():
                    key=row['date']+'/'+row['expiration']
                    status['complete'][key]=row;status['errors'].pop(key,None)
            except Exception as exc:
                failures.append(group)
                for job in group:
                    status['errors'][job['date']+'/'+job['expiration']]=safe_error(exc)
                print(json.dumps({'expiry_failed':group[0]['expiration'],'error':safe_error(exc)}),flush=True)
            status['updated_at']=datetime.now(timezone.utc).isoformat()
            status_path.write_text(json.dumps(status,indent=2)+'\n')
            if n%10==0 or n==len(groups):
                print(json.dumps({'requests_done':n,'requests_total':len(groups),'complete':len(status['complete']),
                                  'errors':len(status['errors'])}),flush=True)
    if failures:
        raise SystemExit(1)


def download(probe=False):
    cfg,record=register()
    jobs=record['jobs']
    grouped=defaultdict(list)
    for job in jobs:
        grouped[job['date']].append(job)
    groups=list(grouped.values())
    if probe:
        groups=[next((g for g in groups if any(not path_for(j).exists() for j in g)),groups[0])]
        jobs=[j for g in groups for j in g]
    status_path=OUT/'download-status.json'
    status=json.loads(status_path.read_text()) if status_path.exists() else {'complete':{},'errors':{}}
    missing=[j for j in jobs if not path_for(j).exists()]
    authorized=client() if missing else None
    print(json.dumps({'jobs':len(jobs),'downloads':len(missing),'probe':probe}),flush=True)
    with ThreadPoolExecutor(max_workers=cfg['download']['workers']) as executor:
        futures={executor.submit(fetch_group,g,authorized,cfg):g for g in groups}
        for n,future in enumerate(as_completed(futures),1):
            group=futures[future]
            try:
                for completed in future.result():
                    key=completed['date']+'/'+completed['expiration']
                    status['complete'][key]=completed;status['errors'].pop(key,None)
            except Exception as exc:
                for job in group:
                    key=job['date']+'/'+job['expiration']
                    status['complete'].pop(key,None);status['errors'][key]=safe_error(exc)
                print(json.dumps({'error_date':group[0]['date'],'message':safe_error(exc)}),flush=True)
            status['updated_at']=datetime.now(timezone.utc).isoformat()
            status_path.write_text(json.dumps(status,indent=2)+'\n')
            if probe or n%25==0 or n==len(groups):
                print(json.dumps({'processed_dates':n,'requested_dates':len(groups),'complete':len(status['complete']),
                                  'errors':len(status['errors'])}),flush=True)
    failures=[j for j in jobs if j['date']+'/'+j['expiration'] in status['errors']]
    if failures:
        raise SystemExit(1)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--probe',action='store_true')
    parser.add_argument('--bulk',action='store_true')
    args=parser.parse_args()
    try:
        download_bulk() if args.bulk else download(args.probe)
    except Exception as exc:
        raise SystemExit(safe_error(exc))
