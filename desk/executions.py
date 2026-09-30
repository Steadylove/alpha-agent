"""Durable, account-isolated execution archive. Never derives trades from positions."""
import csv
import io
import json
import math
import re
import sqlite3
import time
import xml.etree.ElementTree as ET
from contextlib import closing
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

MAX_REPORT = 10 * 1024 * 1024
ZONES = ('America/New_York', 'UTC', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Europe/London')


def xml_root(content):
    if len(content.encode('utf-8')) > MAX_REPORT:
        raise ValueError('报表不能超过 10 MB。')
    if re.search(r'<!\s*(DOCTYPE|ENTITY)', content, re.I):
        raise ValueError('不接受包含 DTD 或实体声明的 XML。')
    try:
        return ET.fromstring(content)
    except ET.ParseError as exc:
        raise ValueError('XML 格式无效，请导出原始 Flex XML 报表。') from exc


def key(value):
    return re.sub(r'[^a-z0-9]', '', value.lower())


def timestamp(value, zone):
    raw = value.strip()
    # Flex date/time formats are selected in Client Portal. Do not guess date-only fills.
    parsed = None
    for fmt in ('%Y%m%d;%H%M%S', '%Y%m%d;%H:%M:%S', '%Y-%m-%d;%H:%M:%S', '%Y-%m-%d %H:%M:%S', '%Y%m%d %H%M%S'):
        try:
            parsed = datetime.strptime(raw, fmt)
            break
        except ValueError:
            pass
    if parsed is None and re.search(r'[T ]\d{2}:\d{2}', raw):
        try:
            parsed = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        except ValueError:
            pass
    if parsed is None:
        raise ValueError('缺少有效成交时间，请包含 Date/Time（YYYYMMDD;HHMMSS），不能只提供日期。')
    if parsed.tzinfo is None:
        tz = ZoneInfo(zone)
        candidates = {parsed.replace(tzinfo=tz, fold=f).astimezone(timezone.utc) for f in (0, 1)
                      if parsed.replace(tzinfo=tz, fold=f).astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None) == parsed}
        if len(candidates) != 1:
            raise ValueError('成交时间位于夏令时切换的歧义或不存在区间，请导出带 UTC 偏移的时间。')
        parsed = candidates.pop()
    return parsed.astimezone(timezone.utc).isoformat()


def finite(value):
    number = float(value.replace(',', ''))
    if not math.isfinite(number):
        raise ValueError('数值必须有限。')
    return number


def parse_report(content, account, zone):
    if zone not in ZONES:
        raise ValueError('请选择报表实际使用的时区。')
    if not account:
        raise ValueError('请先连接 IB Gateway，以确认要导入的账户。')
    if len(content.encode('utf-8')) > MAX_REPORT:
        raise ValueError('报表不能超过 10 MB。')
    content = content.lstrip('\ufeff \r\n\t')
    raw = []
    if content.startswith('<'):
        root = xml_root(content)
        if root.tag not in ('FlexQueryResponse', 'FlexStatements', 'FlexStatement'):
            raise ValueError('请使用包含逐笔成交的 IBKR Flex XML 报表。')
        statements = [root] if root.tag == 'FlexStatement' else root.findall('.//FlexStatement')
        for statement in statements:
            for row in statement.iter():
                if row.tag in ('Trade', 'TradeConfirm'):
                    raw.append({'accountId': statement.get('accountId', ''), **row.attrib})
    else:
        reader = csv.DictReader(io.StringIO(content))
        if not reader.fieldnames or not any(key(k) in ('ibexecid', 'ibexecutionid') for k in reader.fieldnames):
            raise ValueError('CSV 必须为 Flex 逐笔成交报表，并包含 IB Execution ID；不支持汇总对账单。')
        for row in reader:
            if len(raw) >= 50000:
                raise ValueError('单次最多导入 50,000 笔，请分段导出。')
            raw.append({k: v or '' for k, v in row.items() if k is not None})
    if len(raw) > 50000:
        raise ValueError('单次最多导入 50,000 笔，请分段导出。')
    rows, skipped = [], {'other_accounts': 0, 'summaries': 0}
    for index, original in enumerate(raw, 1):
        row = {key(k): str(v).strip() for k, v in original.items()}
        def get(*names):
            return next((row[n] for n in names if row.get(n)), '')
        owner = get('accountid', 'clientaccountid', 'account')
        if not owner:
            raise ValueError(f'第 {index} 条记录缺少 Account ID，无法安全归属账户。')
        if owner != account:
            skipped['other_accounts'] += 1
            continue
        level = get('levelofdetail').upper()
        if level and level not in ('EXECUTION', 'EXECUTIONS'):
            skipped['summaries'] += 1
            continue
        # IBKR: C = closing trade (valid), Ca = cancelled, Co = corrected.
        if get('origtradeid', 'originaltradeid') not in ('', '0') or re.search(r'(^|[;, ])(Ca|Co)([;, ]|$)', get('notes', 'notescodes', 'code')) or 'CANCEL' in get('transactiontype', 'tradetype').upper():
            raise ValueError('报表包含撤销或更正成交，请导出仅含最终有效逐笔成交的报表后重试；本次未写入。')
        execution_id = get('ibexecid', 'ibexecutionid')
        symbol, asset = get('symbol'), get('assetcategory', 'assetclass', 'securitytype').upper()
        side = {'BUY': 'BOT', 'BOT': 'BOT', 'SELL': 'SLD', 'SLD': 'SLD'}.get(get('buysell', 'side').upper())
        try:
            quantity, price = abs(finite(get('quantity', 'shares'))), finite(get('tradeprice', 'price'))
            con_id = int(get('conid'))
            fee = finite(get('ibcommission', 'commission')) if get('ibcommission', 'commission') else None
        except (ValueError, OverflowError):
            raise ValueError(f'第 {index} 条记录缺少有效的数量、成交价或 Conid。') from None
        if not execution_id or len(execution_id) > 128 or not symbol or not asset or not side or not get('currency', 'currencyprimary') or quantity <= 0 or price <= 0 or con_id <= 0:
            raise ValueError(f'第 {index} 条记录字段不完整，请包含 IB Execution ID、资产类型、方向、币种及合约编号。')
        when = get('datetime') or (get('tradedate') + ';' + get('tradetime'))
        rows.append({'id': execution_id, 'symbol': symbol, 'local_symbol': get('localsymbol') or symbol,
                     'con_id': con_id, 'type': asset, 'side': side, 'quantity': quantity, 'price': price,
                     'currency': get('currency', 'currencyprimary'), 'exchange': get('exchange'),
                     'time': timestamp(when, zone),
                     # Flex reports commission expenses as negative; Gateway reports costs positive.
                     'commission': -fee if fee is not None else None,
                     'commission_currency': get('ibcommissioncurrency', 'commissioncurrency') or None})
    if not rows:
        raise ValueError('报表中没有当前账户的有效逐笔成交；请检查账户、报表日期及明细级别。')
    return rows, skipped


class ExecutionArchive:
    def __init__(self, path):
        self.path = path
        with closing(sqlite3.connect(path)) as db, db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS executions (account TEXT NOT NULL, id TEXT NOT NULL,
                symbol TEXT NOT NULL, time TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL,
                updated REAL NOT NULL, PRIMARY KEY(account,id));
              CREATE INDEX IF NOT EXISTS execution_symbol ON executions(account,symbol,time);
              CREATE TABLE IF NOT EXISTS flex_settings (account TEXT PRIMARY KEY, payload TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS execution_imports (id INTEGER PRIMARY KEY, account TEXT NOT NULL,
                created REAL NOT NULL, payload TEXT NOT NULL);
            """)

    def config(self, account):
        with closing(sqlite3.connect(self.path)) as db:
            row = db.execute('SELECT payload FROM flex_settings WHERE account=?', (account,)).fetchone()
            return json.loads(row[0]) if row else {}

    def save_config(self, account, value):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('INSERT OR REPLACE INTO flex_settings VALUES (?,?)', (account, json.dumps(value)))

    def upsert(self, account, rows, source, imported=None):
        result = {'added': 0, 'updated': 0, 'unchanged': 0}
        with closing(sqlite3.connect(self.path)) as db, db:
            for row in rows:
                row = dict(row)
                # IB execution corrections increment the suffix after the final dot.
                family = re.fullmatch(r'([A-Za-z0-9]+(?:\.[A-Za-z0-9]+){2,})\.(\d{2})', row['id'])
                if family:
                    prefix, revision = family.groups()
                    relatives = db.execute('SELECT id FROM executions WHERE account=? AND id LIKE ?', (account, prefix + '.%')).fetchall()
                    if any(int(r[0].rsplit('.', 1)[-1]) > int(revision) for r in relatives if re.fullmatch(r'\d{2}', r[0].rsplit('.', 1)[-1])):
                        result['unchanged'] += 1
                        continue
                    for (rid,) in relatives:
                        if rid != row['id'] and re.fullmatch(r'\d{2}', rid.rsplit('.', 1)[-1]):
                            db.execute('DELETE FROM executions WHERE account=? AND id=?', (account, rid))
                old = db.execute('SELECT source,payload FROM executions WHERE account=? AND id=?', (account,row['id'])).fetchone()
                actual_source = source
                if old:
                    previous = json.loads(old[1])
                    if source == 'gateway' and old[0] != 'gateway':
                        result['unchanged'] += 1
                        continue  # A settled report is authoritative over the transient Gateway cache.
                    for field in ('commission', 'commission_currency'):
                        if row.get(field) is None:
                            row[field] = previous.get(field)
                row['source'] = actual_source
                payload = json.dumps(row, sort_keys=True, allow_nan=False)
                if old and payload == old[1]:
                    result['unchanged'] += 1
                    continue
                db.execute('INSERT OR REPLACE INTO executions VALUES (?,?,?,?,?,?,?)',
                           (account,row['id'],row['symbol'],row['time'],actual_source,payload,time.time()))
                result['updated' if old else 'added'] += 1
            if imported is not None:
                details = {**result, **imported}
                db.execute('INSERT INTO execution_imports(account,created,payload) VALUES (?,?,?)', (account,time.time(),json.dumps(details)))
        return result

    def page(self, account, symbol='', offset=0, limit=1000):
        where, params = 'account=?', [account]
        if symbol:
            where += ' AND symbol=?'
            params.append(symbol)
        with closing(sqlite3.connect(self.path)) as db:
            total = db.execute('SELECT COUNT(*) FROM executions WHERE ' + where, params).fetchone()[0]
            rows = db.execute('SELECT payload FROM executions WHERE ' + where + ' ORDER BY time DESC,id LIMIT ? OFFSET ?', [*params,limit,offset]).fetchall()
        return {'executions': [json.loads(r[0]) for r in rows], 'total':total,
                'next_offset':offset+len(rows) if offset+len(rows)<total else None}

    def status(self, account):
        config = self.config(account)
        with closing(sqlite3.connect(self.path)) as db:
            count, first, last, revision = db.execute('SELECT COUNT(*),MIN(time),MAX(time),MAX(updated) FROM executions WHERE account=?',(account,)).fetchone()
            imported = db.execute('SELECT created,payload FROM execution_imports WHERE account=? ORDER BY id DESC LIMIT 1',(account,)).fetchone()
        return {'configured':bool(config.get('token') and config.get('query_id')), 'query_id':config.get('query_id',''),
                'timezone':config.get('timezone','America/New_York'), 'count':count,'first':first,'last':last,'revision':revision,
                'last_import':{'time':imported[0],**json.loads(imported[1])} if imported else None}
