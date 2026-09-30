import time
from datetime import datetime, timezone, timedelta
import pytest
from fastapi.testclient import TestClient
from desk.app import create_app
from desk.config import Settings
from desk.store import Store

PASSWORD = 'test-password-not-an-ibkr-secret'

class FakeBroker:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store
        self.ready = True
        self.account = 'DU123456'
        self.can_order = False
        self.calls = 0
        self.symbol = 'SPY'
        self.history_calls = 0
        self.working = []
    async def close(self): pass
    async def connect(self): self.ready = True
    def snapshot(self):
        return {'connected': self.ready, 'positions': [{'symbol':'SPY','quantity':5,'con_id':123,'type':'STK','currency':'USD'}], 'working_orders': self.working, 'orders':self.store.orders()}
    def current_quote(self):
        when = datetime.now(timezone.utc) - timedelta(seconds=0)
        return {'symbol': self.symbol, 'kind': 'real', 'bid':100,'ask':100.02,'time':when.isoformat()}
    async def quote(self, symbol): self.symbol=symbol;return self.current_quote()
    async def history(self, *args):
        self.history_calls+=1
        return [{'time':'2025-01-02','open':100,'high':101,'low':99,'close':100,'volume':10}]

@pytest.fixture
def client(tmp_path):
    settings=Settings(password=PASSWORD, db=str(tmp_path/'test.sqlite3'))
    app=create_app(settings, FakeBroker)
    with TestClient(app) as c:
        c.broker=app.state.broker
        c.desk=app
        yield c

def login(c):
    assert c.post('/api/session',json={'password':PASSWORD}).status_code==200

def ticket(**updates):
    return {'symbol':'SPY','side':'BUY','quantity':1,'price':100,'tif':'DAY','outside_rth':False,**updates}

def test_private_api_and_login(client):
    assert client.get('/api/state').status_code==401
    assert client.get('/api/executions').status_code==401
    assert client.get('/api/history?symbol=SPY').status_code==401
    assert client.post('/api/orders',json={'id':'x'*36}).status_code==401
    assert client.post('/api/session',json={'password':'wrong'}).status_code==401
    login(client)
    assert client.get('/api/state').status_code==200
    assert 'httponly' in client.cookies.jar._cookies['testserver.local']['/']['desk_session']._rest.keys().__str__().lower()
    client.delete('/api/session')
    assert client.get('/api/state').status_code==401

def test_cross_origin_login_and_order_are_rejected(client):
    assert client.post('/api/session',headers={'origin':'https://attacker.invalid'},json={'password':PASSWORD}).status_code==403
    login(client)
    assert client.post('/api/orders/preview',headers={'origin':'https://attacker.invalid'},json=ticket()).status_code==403

def test_missing_password_fails_closed(tmp_path):
    with TestClient(create_app(Settings(db=str(tmp_path/'empty.sqlite3')),FakeBroker)) as c:
        assert c.post('/api/session',json={'password':''}).status_code==503
        assert c.get('/api/state').status_code==401

def test_login_rate_limit(client):
    for _ in range(8): assert client.post('/api/session',json={'password':'wrong'}).status_code==401
    assert client.post('/api/session',json={'password':'wrong'}).status_code==429

def test_historical_cache_survives_disconnect(client):
    login(client)
    r=client.get('/api/history?symbol=SPY&period=1d')
    assert r.status_code==200 and r.json()['source']=='IBKR'
    client.broker.ready=False
    r=client.get('/api/history?symbol=SPY&period=1d')
    assert r.json()['cached'] and r.json()['stale']
    assert client.broker.history_calls==1
    assert client.get('/api/history?symbol=AAPL').status_code==503

def test_invalid_history_and_symbol(client):
    login(client)
    assert client.get('/api/history?symbol=SPY&period=1s').status_code==422
    assert client.get('/api/history?symbol=SPY&end=2099-01-01').status_code==400
    assert client.get('/api/history?symbol=../config').status_code==422

def test_journal_retained_across_restart(tmp_path):
    path=str(tmp_path/'journal.sqlite3')
    store=Store(path)
    store.reserve('saved',{'symbol':'SPY','account':'DU123456'})
    store.record('saved','Submitted',{'filled':0})
    store.db.close()
    restored=Store(path)
    assert restored.order('saved')['state']=='Submitted'
    assert restored.order('saved')['broker']['filled']==0
    restored.db.close()


@pytest.mark.parametrize('account', ['U123456','DU123456'])
@pytest.mark.parametrize('legacy_toggle', ['true','false'])
def test_connection_is_readonly_for_every_account_even_with_old_toggle(tmp_path,monkeypatch,account,legacy_toggle):
    import asyncio
    from unittest.mock import AsyncMock, Mock
    from desk.broker import Broker
    monkeypatch.setenv('DESK_PAPER_ORDERS',legacy_toggle)
    monkeypatch.setenv('DESK_PASSWORD',PASSWORD)
    settings=Settings.from_env()
    assert not hasattr(settings,'paper_orders')
    async def run():
        store=Store(str(tmp_path/'connection.sqlite3'))
        broker=Broker(settings,store)
        broker.ib.connectAsync=AsyncMock()
        broker.ib.isConnected=Mock(return_value=True)
        broker.ib.managedAccounts=Mock(return_value=[account])
        broker.ib.reqAccountSummaryAsync=AsyncMock()
        broker.ib.reqAllOpenOrdersAsync=AsyncMock(side_effect=AssertionError('write-capable order sync'))
        broker.ib.reqCompletedOrdersAsync=AsyncMock(side_effect=AssertionError('write-capable order sync'))
        broker.ib.reqMarketDataType=Mock()
        broker.ib.reqPnL=Mock()
        broker.ib.positions=Mock(return_value=[])
        broker.ib.disconnect=Mock()
        try:
            await broker.connect()
            assert broker.ready and not broker.can_order
            assert broker.ib.connectAsync.call_args.kwargs['readonly'] is True
            broker.ib.reqAccountSummaryAsync.assert_awaited_once()
            broker.ib.reqAllOpenOrdersAsync.assert_not_awaited()
            broker.ib.reqCompletedOrdersAsync.assert_not_awaited()
            assert not hasattr(broker,'submit') and not hasattr(broker,'cancel')
        finally:
            await broker.close()
            store.db.close()
    asyncio.run(run())


def test_connection_rejects_client_zero_before_auto_order_binding(tmp_path):
    import asyncio
    from unittest.mock import AsyncMock
    from desk.broker import Broker

    async def run():
        store = Store(str(tmp_path/'client-zero.sqlite3'))
        broker = Broker(Settings(client_id=0), store)
        await asyncio.sleep(0)
        broker.ib.connectAsync = AsyncMock()
        try:
            with pytest.raises(ValueError, match='IB_CLIENT_ID'):
                await broker.connect()
            broker.ib.connectAsync.assert_not_awaited()
        finally:
            await broker.close()
            store.db.close()
    asyncio.run(run())


def history_bar(stamp, close=100):
    return {'time':stamp,'open':100,'high':102,'low':98,'close':close,'volume':10}


def test_daily_pagination_excludes_boundary_and_deduplicates(client):
    from unittest.mock import AsyncMock
    login(client)
    client.broker.history=AsyncMock(return_value=[history_bar('2025-03-07'),history_bar('2025-03-10'),
        history_bar('2025-03-06'),history_bar('2025-03-07',101)])
    data=client.get('/api/history?symbol=SPY&period=1d&before=2025-03-10').json()
    assert [b['time'] for b in data['bars']]==['2025-03-06','2025-03-07']
    assert data['bars'][1]['close']==101
    assert data['next_before']=='2025-03-06'
    until=client.broker.history.call_args.args[3]
    assert until.hour==0 and until.utcoffset()==timedelta(hours=-4)


def test_intraday_cursor_is_exact_utc_second(client):
    from unittest.mock import AsyncMock
    login(client)
    stamp=int(datetime(2025,3,10,13,30,tzinfo=timezone.utc).timestamp())
    client.broker.history=AsyncMock(return_value=[history_bar(stamp),history_bar(stamp-60),history_bar(stamp-120)])
    data=client.get(f'/api/history?symbol=SPY&period=1m&before={stamp}').json()
    assert [b['time'] for b in data['bars']]==[stamp-120,stamp-60]
    assert data['next_before']==str(stamp-120)
    assert client.broker.history.call_args.args[3].timestamp()==stamp


@pytest.mark.parametrize('query',[
    'period=1d&before=2025-02-29','period=1d&before=2025-1-02',
    'period=1d&before=2025-01-02&end=2025-01-03',
    'period=1m&before=2025-01-02','period=1m&before=abc',
    'period=1m&before=-1','period=1m&before=9999999999',
    'period=1d&before=2099-01-01',
])
def test_invalid_pagination_never_reaches_broker(client,query):
    login(client)
    assert client.get('/api/history?symbol=SPY&'+query).status_code==400
    assert client.broker.history_calls==0


def test_inclusive_end_day_handles_dst(client):
    from unittest.mock import AsyncMock
    login(client)
    client.broker.history=AsyncMock(return_value=[history_bar('2025-03-09'),history_bar('2025-03-10')])
    data=client.get('/api/history?symbol=SPY&end=2025-03-09').json()
    assert [b['time'] for b in data['bars']]==['2025-03-09']
    assert client.broker.history.call_args.args[3].isoformat()=='2025-03-10T00:00:00-04:00'


@pytest.mark.parametrize('failure',[[],TimeoutError('slow'),RuntimeError('permission')])
def test_failed_older_page_is_not_cached_or_treated_as_history_end(client,failure):
    from unittest.mock import AsyncMock
    login(client)
    client.broker.history=AsyncMock(return_value=failure if isinstance(failure,list) else None,
                                  side_effect=failure if isinstance(failure,Exception) else None)
    url='/api/history?symbol=SPY&before=2025-01-03'
    assert client.get(url).status_code==503
    assert client.get(url).status_code==503
    assert client.broker.history.await_count==2
    assert client.desk.state.store.db.execute('SELECT count(*) FROM history').fetchone()[0]==0


def test_page_cache_isolated_by_symbol_period_session_and_cursor(client):
    from unittest.mock import AsyncMock
    login(client)
    client.broker.history=AsyncMock(return_value=[history_bar('2024-01-02')])
    for query in ['symbol=SPY','symbol=QQQ','symbol=SPY&rth=false','symbol=SPY&before=2025-01-03','symbol=SPY&end=2025-01-03']:
        assert client.get('/api/history?'+query).status_code==200
    assert client.broker.history.await_count==5
    assert client.get('/api/history?symbol=SPY').json()['cached']
    client.broker.history.return_value=[history_bar(1704205800)]
    assert client.get('/api/history?symbol=SPY&period=1h').status_code==200
    assert client.broker.history.await_count==6


def test_historical_page_survives_process_restart(tmp_path):
    settings=Settings(password=PASSWORD,db=str(tmp_path/'pages.sqlite3'))
    url='/api/history?symbol=SPY&before=2025-01-03'
    with TestClient(create_app(settings,FakeBroker)) as first:
        login(first)
        expected=first.get(url).json()
    app=create_app(settings,FakeBroker)
    with TestClient(app) as second:
        login(second)
        app.state.broker.ready=False
        restored=second.get(url).json()
        assert restored['bars']==expected['bars']
        assert restored['next_before']==expected['next_before']
        assert restored['cached'] and restored['stale']
        assert app.state.broker.history_calls==0


def test_concurrent_identical_pages_only_download_once(tmp_path):
    import asyncio
    from desk.history import HistoryService
    async def run():
        store=Store(str(tmp_path/'concurrent.sqlite3'))
        broker=FakeBroker(Settings(),store)
        history=HistoryService(broker,store)
        try:
            pages=await asyncio.gather(*[history.page('SPY',before='2025-01-03') for _ in range(3)])
            assert broker.history_calls==1
            assert sum(page['cached'] for page in pages)==2
        finally:
            store.db.close()
    asyncio.run(run())


def test_expired_page_keeps_cache_on_broker_failure(client):
    from unittest.mock import AsyncMock
    login(client)
    url='/api/history?symbol=SPY&before=2025-01-03'
    expected=client.get(url).json()
    store=client.desk.state.store
    store.db.execute('UPDATE history SET updated=?',(time.time()-90000,))
    store.db.commit()
    client.broker.history=AsyncMock(side_effect=TimeoutError('slow'))
    restored=client.get(url).json()
    assert restored['bars']==expected['bars']
    assert restored['cached'] and restored['stale'] and restored['warning']


@pytest.mark.parametrize('method,path', [
    ('POST','/api/orders/preview'),('POST','/api/orders'),('POST','/api/orders/old/cancel'),
    ('PUT','/api/orders/old'),('PATCH','/api/orders/old'),('DELETE','/api/orders/old'),
    ('POST','/api/withdraw'),('POST','/api/transfer'),('POST','/api/exercise'),
    ('POST','/api/rpc'),('POST','/api/orders/'),('POST','/api/connect/'),
])
@pytest.mark.parametrize('account', ['U123456','DU123456'])
def test_all_broker_writes_are_rejected_before_adapter(client,method,path,account):
    from unittest.mock import AsyncMock
    login(client)
    client.broker.account=account
    # Even a misconfigured/replaced adapter cannot bypass the HTTP boundary.
    client.broker.can_order=True
    client.broker.submit=AsyncMock(side_effect=AssertionError('broker mutation'))
    client.broker.cancel=AsyncMock(side_effect=AssertionError('broker mutation'))
    result=client.request(method,path,json=ticket())
    assert result.status_code==403 and '固定为只读' in result.json()['detail']
    client.broker.submit.assert_not_awaited()
    client.broker.cancel.assert_not_awaited()
    assert client.desk.state.store.orders()==[]


def test_auth_connect_and_read_routes_remain_available(client):
    from unittest.mock import AsyncMock
    assert client.get('/api/health').json()['read_only'] is True
    login(client)
    client.broker.refresh_executions=AsyncMock(return_value={'executions':[]})
    assert client.post('/api/connect').status_code==200
    for path in ['/api/state','/api/history?symbol=SPY','/api/quote?symbol=SPY','/api/executions']:
        assert client.get(path).status_code==200
    assert client.delete('/api/session').status_code==200
    assert client.get('/api/state').status_code==401


def test_adapter_only_calls_read_or_session_operations():
    import ast
    from pathlib import Path
    from desk.config import ROOT
    allowed={'managedAccounts','isConnected','positions','cancelPnLSingle','reqPnLSingle','disconnect',
             'connectAsync','reqAccountSummaryAsync','reqMarketDataType','reqPnL','qualifyContractsAsync',
             'reqHistoricalDataAsync','cancelMktData','reqMktData','fills','reqExecutionsAsync',
             'accountValues','portfolio','openTrades'}
    tree=ast.parse((ROOT/'desk/broker.py').read_text())
    calls={node.func.attr for node in ast.walk(tree) if isinstance(node,ast.Call)
           and isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Attribute)
           and isinstance(node.func.value.value,ast.Name) and node.func.value.value.id=='self'
           and node.func.value.attr=='ib'}
    assert calls<=allowed
    assert not (ROOT/'desk/orders.py').exists()


NEW_PASSWORD = 'new-pw'

def password_change(current=PASSWORD, new=NEW_PASSWORD, confirmation=None):
    return {'current_password':current, 'new_password':new, 'confirm_password':new if confirmation is None else confirmation}


def test_password_change_from_login_revokes_all_sessions(client):
    login(client)
    first=client.cookies.get('desk_session')
    login(client)
    second=client.cookies.get('desk_session')
    assert first != second
    client.cookies.clear()
    # The current password is required, but an existing browser session is not.
    response=client.post('/api/password',json=password_change())
    assert response.status_code==200 and response.json()['requires_login']
    assert 'no-store' in response.headers['cache-control']
    for token in [first,second]:
        assert client.get('/api/state',headers={'cookie':f'desk_session={token}'}).status_code==401
    assert client.post('/api/session',json={'password':PASSWORD}).status_code==401
    assert client.post('/api/session',json={'password':NEW_PASSWORD}).status_code==200
    assert client.get('/api/state').status_code==200
    for path in ['/api/orders','/api/withdraw','/api/transfer','/api/exercise']:
        assert client.post(path,json={}).status_code==403
    assert client.get('/api/health').json()['read_only'] is True


@pytest.mark.parametrize(('body','status'),[
    (password_change(current='wrong'),401),
    (password_change(new='12345'),422),
    (password_change(new='x'*513),422),
    (password_change(confirmation='different-new-password'),400),
    (password_change(new=PASSWORD),400),
    ({'new_password':NEW_PASSWORD,'confirm_password':NEW_PASSWORD},422),
])
def test_invalid_password_change_preserves_existing_access(client,body,status):
    login(client)
    assert client.post('/api/password',json=body).status_code==status
    assert client.get('/api/state').status_code==200
    assert client.desk.state.store.password_hash() is None
    login(client)


def test_password_change_persists_hash_and_overrides_bootstrap(tmp_path):
    from desk.auth import check_password
    path=str(tmp_path/'password.sqlite3')
    with TestClient(create_app(Settings(password=PASSWORD,db=path),FakeBroker)) as client:
        assert client.post('/api/password',json=password_change()).status_code==200
        stored=client.app.state.store.password_hash()
        assert stored.startswith('pbkdf2_sha256$600000$')
        assert PASSWORD not in stored and NEW_PASSWORD not in stored
        assert check_password(NEW_PASSWORD,stored)
        assert not check_password(PASSWORD,stored)
    for bootstrap in [PASSWORD,'', 'another-bootstrap-password']:
        with TestClient(create_app(Settings(password=bootstrap,db=path),FakeBroker)) as client:
            assert client.get('/api/health').json()['configured']
            assert client.post('/api/session',json={'password':PASSWORD}).status_code==401
            assert client.post('/api/session',json={'password':NEW_PASSWORD}).status_code==200
    assert NEW_PASSWORD.encode() not in (tmp_path/'password.sqlite3').read_bytes()


def test_password_change_and_login_share_failure_limit(client):
    for _ in range(4):
        assert client.post('/api/password',json=password_change(current='wrong')).status_code==401
        assert client.post('/api/session',json={'password':'wrong'}).status_code==401
    assert client.post('/api/password',json=password_change()).status_code==429
    assert client.post('/api/session',json={'password':PASSWORD}).status_code==429
    assert client.desk.state.store.password_hash() is None


def test_password_change_requires_same_origin(client):
    assert client.post('/api/password',json=password_change(),headers={'origin':'https://other.invalid'}).status_code==403
    assert client.desk.state.store.password_hash() is None
    assert client.post('/api/password',json=password_change(),headers={'origin':'http://testserver'}).status_code==200
    assert client.post('/api/password',json=password_change()).status_code==401


def test_failed_password_save_preserves_password_and_sessions(client,monkeypatch):
    import sqlite3
    login(client)
    def fail(encoded): raise sqlite3.OperationalError('readonly database')
    monkeypatch.setattr(client.desk.state.store,'save_password_hash',fail)
    response=client.post('/api/password',json=password_change())
    assert response.status_code==503
    assert client.get('/api/state').status_code==200
    login(client)
    assert client.post('/api/session',json={'password':NEW_PASSWORD}).status_code==401


def test_corrupt_saved_password_does_not_fall_back_to_env(tmp_path):
    from desk.auth import Authentication
    store=Store(str(tmp_path/'corrupt.sqlite3'))
    store.save_password_hash('broken')
    try:
        with pytest.raises(ValueError): Authentication(PASSWORD,store)
    finally: store.db.close()


def test_concurrent_password_changes_accept_old_password_only_once(client):
    from concurrent.futures import ThreadPoolExecutor
    from fastapi import HTTPException
    auth=client.desk.state.auth
    login(client)
    old_token=client.cookies.get('desk_session')
    def change(suffix):
        password=NEW_PASSWORD+suffix
        try:
            auth.change_password(PASSWORD,password,password,'parallel-test')
            return password,200
        except HTTPException as error: return password,error.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(change,['-first','-second']))
    assert sorted(code for _,code in results)==[200,401]
    assert not auth.valid_session(old_token)
    winner=next(password for password,code in results if code==200)
    assert client.post('/api/session',json={'password':winner}).status_code==200


def test_password_change_never_initializes_unconfigured_service(tmp_path):
    with TestClient(create_app(Settings(db=str(tmp_path/'unconfigured.sqlite3')),FakeBroker)) as client:
        assert client.post('/api/password',json=password_change()).status_code==503
        assert not client.get('/api/health').json()['configured']


def test_history_carries_contract_identity_for_trade_markers(client):
    from types import SimpleNamespace
    login(client)
    client.broker.contracts={'SPY':SimpleNamespace(conId=756733)}
    result=client.get('/api/history?symbol=SPY').json()
    assert result['con_id']==756733
    assert client.get('/api/history?symbol=SPY').json()['con_id']==756733
