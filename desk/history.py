"""Bounded, exclusive-cursor historical pages, persisted independently of the browser."""
import asyncio
import json
import re
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from fastapi import HTTPException

NY = ZoneInfo('America/New_York')
PERIODS = {'1m': ('1 min', '5 D'), '5m': ('5 mins', '1 M'), '15m': ('15 mins', '1 M'),
           '1h': ('1 hour', '3 M'), '1d': ('1 day', '1 Y')}


def parse_day(value):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('日期格式必须为 YYYY-MM-DD。')
    return datetime.strptime(value, '%Y-%m-%d').replace(tzinfo=NY)


def boundary(period, end, before):
    if end and before:
        raise ValueError('end 与 before 不能同时使用。')
    now = datetime.now(NY)
    if end:
        day = parse_day(end)
        if day.date() > now.date():
            raise ValueError('不能请求未来日期的行情。')
        return day + timedelta(days=1)
    if before:
        if period == '1d':
            value = parse_day(before)
        else:
            if not re.fullmatch(r'[0-9]{1,10}', before):
                raise ValueError('日内翻页游标必须为 Unix 秒时间戳。')
            value = datetime.fromtimestamp(int(before), timezone.utc)
        if value > now:
            raise ValueError('不能请求未来日期的行情。')
        return value
    return None


def bar_time(value, period):
    if period == '1d':
        return parse_day(str(value)).timestamp()
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError('日内 K 线时间无效。')
    return value


class HistoryService:
    def __init__(self, broker, store):
        self.broker, self.store = broker, store
        # Recheck SQLite inside the lock so identical concurrent requests share a page.
        self.lock = asyncio.Lock()

    async def page(self, symbol, period='1d', end='', rth=True, before=''):
        if period not in PERIODS:
            raise HTTPException(422, '不支持的周期。')
        until = boundary(period, end, before)
        key = json.dumps(['history-v2', symbol, period, end, rth, before])
        # Revisit completed chunks daily: corporate actions can revise historical prices.
        ttl = 86400 if until and until.date() < datetime.now(NY).date() else 60
        async with self.lock:
            cached = self.store.cache(key)
            if cached and (time.time() - cached[1] < ttl or not self.broker.ready):
                return {**cached[0], 'cached': True, 'stale': not self.broker.ready, 'updated': cached[1]}
            if not self.broker.ready:
                raise HTTPException(503, '尚未连接 IB Gateway，本地也没有该区间的缓存。')
            try:
                bar, duration = PERIODS[period]
                raw = await self.broker.history(symbol, bar, duration, until, rth)
                # IBKR may include the boundary bar. Never repeat it as the next cursor.
                unique = {bar_time(b['time'], period): b for b in raw}
                bars = [b for stamp, b in sorted(unique.items()) if until is None or stamp < until.timestamp()]
                if not bars:
                    raise ValueError('empty history page')
            except Exception as exc:
                if cached:
                    return {**cached[0], 'cached': True, 'stale': True, 'updated': cached[1],
                            'warning': '补采未成功，当前展示历史缓存。'}
                # Empty pages can also mean timeout, permission failure or a trading gap.
                # Do not cache them or declare that all history has been downloaded.
                raise HTTPException(503, '本次未取得该区间的 K 线。可能是数据范围、权限或临时超时；可重试或更换截止日期。') from exc
            contract = getattr(self.broker, 'contracts', {}).get(symbol)
            result = {'con_id': getattr(contract, 'conId', None), 'symbol': symbol, 'period': period, 'bars': bars, 'source': 'IBKR', 'rth': rth,
                      'price_basis': 'TRADES', 'timezone': 'America/New_York', 'cached': False,
                      'stale': False, 'warning': None, 'updated': time.time(),
                      'next_before': str(bars[0]['time'])}
            self.store.cache_put(key, result)
            return result
