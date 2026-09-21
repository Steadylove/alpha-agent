"""Freeze inputs and download only missing quotes for the fixed Balder short-put study."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, time, timezone
from functools import partial
from html.parser import HTMLParser
import hashlib
import json
import math
import re
import threading
import urllib.request

import polars as pl

from intraday import contract_path, validate_contract, write_json
from provider import ET, ROOT, client, safe_error
from replay import index_rows

PLAN = ROOT / 'research/options/balder-short-put-v1.json'
OUT = ROOT / 'data/thetadata/balder-short-put-v1'
_local = threading.local()


class Tables(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables, self.table, self.row, self.cell = [], None, None, None

    def handle_starttag(self, tag, attrs):
        if tag == 'table': self.table = []
        elif tag == 'tr' and self.table is not None: self.row = []
        elif tag in ('td', 'th') and self.row is not None: self.cell = []

    def handle_data(self, data):
        if self.cell is not None: self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.cell is not None:
            self.row.append(' '.join(''.join(self.cell).split()))
            self.cell = None
        elif tag == 'tr' and self.row is not None:
            self.table.append(self.row)
            self.row = None
        elif tag == 'table' and self.table is not None:
            self.tables.append(self.table)
            self.table = None


def fetch_url(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30).read()


def register():
    OUT.mkdir(parents=True, exist_ok=True)
    cfg = json.loads(PLAN.read_text())
    digest = hashlib.sha256(PLAN.read_bytes()).hexdigest()
    path = OUT / 'registered-plan.json'
    if path.exists():
        if json.loads(path.read_text())['sha256'] != digest:
            raise ValueError('Registered plan changed; use a new version')
    else:
        write_json(path, {'registered_at': datetime.now(timezone.utc).isoformat(), 'sha256': digest, 'plan': cfg})
    return cfg


def freeze_ledger(cfg):
    target = OUT / 'ledger.json'
    if target.exists(): return json.loads(target.read_text())
    original = json.loads((ROOT / cfg['original_ledger']).read_text())
    raw = fetch_url(cfg['source_url'])
    (OUT / 'blogger-source.html').write_bytes(raw)
    parser = Tables()
    parser.feed(raw.decode())
    tables = [t for t in parser.tables if t and 'Session' in t[0] and '68% band' in t[0]]
    if len(tables) != 1: raise ValueError('Expected one SPX forecast ledger')
    current = {}
    for cells in tables[0][1:]:
        day, b68, b95, close, *_ = cells
        if not cfg['first_date'] <= day <= cfg['last_date']: continue
        bands = {b: [float(n.replace(',', '')) for n in re.findall(r'[\d,]+(?:\.\d+)?', val)]
                 for b, val in [('68', b68), ('95', b95)]}
        if any(len(v) != 2 or not 0 < v[0] < v[1] for v in bands.values()):
            raise ValueError('Invalid range')
        current[day] = {'date': day, 'bands': bands, 'settlement_price': float(close.replace(',', ''))}
    for old in original['sessions']:
        new = current.get(old['date'])
        if not new or any(new[k] != old[k] for k in ('bands', 'settlement_price')):
            raise ValueError(f"Published history changed on {old['date']}; resolve revisions before replay")
    if current.get('2026-09-16', {}).get('bands') != {'68': [7501.0, 7667.0], '95': [7420.0, 7750.0]}:
        raise ValueError('Sep 16 ranges differ from previously observed user screenshot')
    today = datetime.now(ET).date()
    p1 = int(datetime.combine(date.fromisoformat(cfg['first_date']), time(), timezone.utc).timestamp())
    p2 = int(datetime.combine(today, time(), timezone.utc).timestamp())
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1={p1}&period2={p2}&interval=1d'
    independent_raw = fetch_url(url)
    (OUT / 'independent-closes-raw.json').write_bytes(independent_raw)
    item = json.loads(independent_raw)['chart']['result'][0]
    values = item['indicators']['quote'][0]['close']
    independent = {datetime.fromtimestamp(ts, ET).date().isoformat(): round(values[i], 2)
                   for i, ts in enumerate(item['timestamp']) if values[i] is not None
                   and datetime.fromtimestamp(ts, ET).date() < today}
    for day, record in current.items():
        if independent.get(day) != record['settlement_price']:
            raise ValueError(f'Independent SPX close missing or inconsistent: {day}')
    ledger = {'source_url': cfg['source_url'], 'retrieved_at': datetime.now(timezone.utc).isoformat(),
              'source_sha256': hashlib.sha256(raw).hexdigest(),
              'original_ledger_sha256': hashlib.sha256((ROOT / cfg['original_ledger']).read_bytes()).hexdigest(),
              'original_sessions_unchanged': len(original['sessions']),
              'independent_close_source': url, 'independent_close_sha256': hashlib.sha256(independent_raw).hexdigest(),
              'publication_caveat': cfg['publication_caveat'],
              'sessions': sorted(current.values(), key=lambda r: r['date'])}
    write_json(target, ledger)
    return ledger


def fetch_contract(spec, authorized):
    day, strike, right = spec
    path = contract_path(*spec)
    path.parent.mkdir(parents=True, exist_ok=True)
    source = 'existing single-contract cache'
    if path.exists(): frame = pl.read_parquet(path)
    elif (path.parent / 'quotes.parquet').exists():
        frame = pl.read_parquet(path.parent / 'quotes.parquet').filter(
            (pl.col('strike') == strike) & pl.col('right').str.to_lowercase().is_in(['put', 'p']) &
            (pl.col('timestamp').dt.strftime('%H:%M:%S') >= '10:00:00') &
            (pl.col('timestamp').dt.strftime('%H:%M:%S') <= '15:59:00'))
        source = 'existing full-day cache'
    else:
        if not hasattr(_local, 'theta'):
            from thetadata import ThetaClient
            _local.theta = ThetaClient(existing_authorized_client=authorized)
            _local.theta.stub.GetOptionHistoryQuote = partial(_local.theta.stub.GetOptionHistoryQuote, timeout=60)
        d = date.fromisoformat(day)
        frame = _local.theta.option_history_quote(symbol='SPXW', expiration=d, date=d,
            strike=f'{strike:g}', right=right, interval='1m', start_time='10:00:00', end_time='15:59:00')
        source = 'ThetaData 1m NBBO, exact selected put only'
    validate_contract(frame, *spec)
    if not path.exists(): frame.sort('timestamp').write_parquet(path)
    return {'date': day, 'strike': strike, 'right': right, 'rows': frame.height, 'source': source,
            'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'path': str(path)}


def main():
    cfg = register()
    ledger = freeze_ledger(cfg)
    print(f"Frozen {len(ledger['sessions'])} sessions; original 38 unchanged; independent closes matched", flush=True)
    specs = sorted({(s['date'], math.floor(s['bands'][band][0] / 5) * 5, 'put')
                    for s in ledger['sessions'] for band in cfg['bands']})
    missing = sum(not contract_path(*s).exists() for s in specs)
    print(f'{len(specs)} selected contracts; {missing} paths not cached', flush=True)
    authorized = client() if missing else None
    completed, errors = {}, {}
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {executor.submit(fetch_contract, spec, authorized): spec for spec in specs}
        for future in as_completed(futures):
            spec = futures[future]
            key = '|'.join(map(str, spec))
            try: completed[key] = future.result()
            except Exception as exc: errors[key] = safe_error(exc)
            n = len(completed) + len(errors)
            if n % 10 == 0 or n == len(specs) or key in errors:
                print(f'[{n}/{len(specs)}] complete; errors={len(errors)}; latest={key}', flush=True)
            write_json(OUT / 'download-status.json', {'completed': completed, 'errors': errors})
    if errors: raise RuntimeError('Some contracts missing; see redacted download-status.json')


if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print(safe_error(exc), flush=True)
        raise SystemExit(1)
